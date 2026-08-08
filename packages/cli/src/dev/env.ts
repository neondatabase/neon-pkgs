import {
	type Config,
	createNeonApiFromOptions,
	ErrorCode,
	loadConfigFromFile,
	type NeonApi,
	type NeonBucketSnapshot,
	type NeonDataApiSnapshot,
	PlatformError,
} from "@neon/config";
import { type AppliedChange, plan, pullConfig } from "@neon/config-runtime";
import {
	type CredentialOutcome,
	fetchEnvReusingSecrets,
	type ReusedBranchEnv,
} from "@neon/env/runtime";

import type { EnvService } from "../env_services.js";
import { log } from "../log.js";
import { getCliName } from "../utils/cli_name.js";

export type DevEnvContext = {
	cwd: string;
	projectId?: string;
	branchId?: string;
	apiKey?: string;
	/** Neon API base URL. Falls back to `NEON_API_HOST`, then production. */
	apiHost?: string;
	/** Injected NeonApi adapter (tests). Production builds it from `apiKey`. */
	api?: NeonApi;
	/**
	 * Env source layered under `process.env` when resolving the branch env. Lets callers
	 * supply already-persisted values (e.g. the existing `.env` for `env pull`) so one-time
	 * secrets — Neon Auth keys and the unified branch credential's `api_token` /
	 * `s3_secret_access_key` — are **reused** rather than re-minted on every run. See
	 * {@link fetchEnvReusingSecrets}, which verifies them against the branch before keeping
	 * them.
	 */
	env?: NodeJS.ProcessEnv;
	/**
	 * Resolve env for exactly these services, ignoring any `neon.ts`. This is
	 * `env pull --service`: an explicit selection is the user overriding the policy, so the
	 * tiered resolution below is skipped and the selection is checked against the branch's
	 * live state instead.
	 */
	services?: readonly EnvService[];
	/**
	 * Add the AI Gateway to the **no-`neon.ts`** resolution. `pullConfig` cannot detect the
	 * gateway — it has no branch-level enabled state, only a credential — so a caller that
	 * wants it in the "everything this branch has" set has to ask. `neon env pull` does;
	 * `neon dev` and the pull bundled into `link` / `checkout` / `apply` do not. Ignored when
	 * {@link DevEnvContext.services} is set, since that selection already says.
	 */
	implyAiGateway?: boolean;
};

/** The API-targeting options every runtime call forwards from the context. */
const apiOptions = (ctx: DevEnvContext) => ({
	...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
	...(ctx.apiHost ? { apiHost: ctx.apiHost } : {}),
	...(ctx.api ? { api: ctx.api } : {}),
});

/**
 * Thrown when a `neon.ts` policy declares a branch-level resource (Neon Auth,
 * Data API, a bucket, the AI Gateway) that the linked remote branch does not
 * have yet. Unlike every other failure in {@link resolveDevEnv} — which degrades
 * to "run without injection" — this is a hard stop: the user's intent (a policy)
 * cannot be honored, and silently dropping the secret would be more confusing
 * than refusing to start. The fix is to provision the resource first.
 */
export class DevEnvMismatchError extends Error {
	override readonly name = "DevEnvMismatchError";
}

/**
 * Signals that no project/branch context could be resolved, so there is nothing to
 * resolve env from. `resolveDevEnv` degrades on this (dev runs without injection);
 * `env pull` surfaces it (an explicit pull needs a branch).
 */
export class MissingBranchContextError extends Error {
	override readonly name = "MissingBranchContextError";
}

/**
 * Thrown when an explicit `--service` selection names a service the branch does not have.
 * Unlike the policy path — where the same situation is a {@link DevEnvMismatchError} pointing
 * at `deploy` — the user named the service on the command line, so the fix is to provision it
 * or drop it from the selection.
 */
export class ServiceNotOnBranchError extends Error {
	override readonly name = "ServiceNotOnBranchError";
}

/** What {@link resolveNeonEnvVars} produced, and what it could not. */
export type ResolvedNeonEnvVars = ReusedBranchEnv & {
	/**
	 * Services that were asked for but yielded nothing, so a caller can say so rather than
	 * report a complete pull. Only the *implied* AI Gateway can land here (see
	 * {@link DevEnvContext.implyAiGateway}); a service the user named explicitly raises
	 * instead of being skipped.
	 */
	skipped?: readonly EnvService[];
};

/**
 * Resolve the branch's Neon env vars (pooled / direct `DATABASE_URL`, plus Auth /
 * Data API when enabled) into a `{ KEY: value }` map. Shared by `neon dev` (which
 * injects them) and `neon env pull` (which writes them to a `.env` file).
 *
 * Tiered:
 *
 *   0. {@link DevEnvContext.services} is set -> that selection *is* the policy, and any
 *      `neon.ts` is ignored. See {@link resolveSelectedServices}.
 *   1. a `neon.ts` policy is found -> the policy is the source of truth. We first
 *      check it against the branch's live state (`plan`); if it declares a resource
 *      the branch is missing, we stop with a {@link DevEnvMismatchError} pointing at
 *      `neonctl deploy`. Otherwise `fetchEnv` evaluates the policy.
 *   2. no `neon.ts`, but a project + branch are known -> `pullConfig` reads the
 *      branch's live state (Auth / Data API enablement plus any object-storage
 *      buckets) into a config, then `fetchEnv` resolves what is actually enabled —
 *      so a branch with a bucket gets its `AWS_*` storage vars pulled with no policy.
 *      With {@link DevEnvContext.implyAiGateway}, the AI Gateway is added on top, since
 *      `pullConfig` cannot read it back.
 *   3. otherwise -> throw {@link MissingBranchContextError}.
 *
 * Unlike {@link resolveDevEnv}, this never swallows errors — callers decide how to
 * handle them.
 */
export const resolveNeonEnvVars = async (
	ctx: DevEnvContext,
): Promise<ResolvedNeonEnvVars> => {
	if (ctx.services) {
		return await resolveSelectedServices(ctx, ctx.services);
	}

	const config = await loadNeonConfig(ctx.cwd);

	if (config) {
		if (!ctx.projectId || !ctx.branchId) {
			throw new MissingBranchContextError(
				"Found a neon.ts but could not resolve the project/branch. " +
					`Run \`${getCliName()} link\` and \`${getCliName()} checkout <branch>\`, or pass ` +
					"--project-id / --branch.",
			);
		}
		// Resolve env from the policy with its `preview.functions` removed. Functions carry no
		// branch-level secrets — their env comes from the local `neon.ts` `functions.<slug>.env`,
		// layered per-function by the dev server — so env resolution never needs the functions
		// API. Probing it (via `plan`/`fetchEnv`) only adds a failure mode: an undeployed
		// function, or a project where the Functions Preview isn't enabled, would error and sink
		// ALL injection (including DATABASE_URL). Stripping functions keeps env resolution honest
		// while leaving buckets / AI Gateway / Auth / Data API fully checked — those DO carry
		// secrets, so a declared-but-missing one still hard-stops (see assertPolicyMatchesBranch).
		const envConfig = withoutPreviewFunctions(config);
		await assertPolicyMatchesBranch(envConfig, ctx);
		return await fetchAndProject(envConfig, ctx);
	}

	if (ctx.projectId && ctx.branchId) {
		const pulled = await pullConfig({
			projectId: ctx.projectId,
			branchId: ctx.branchId,
			...apiOptions(ctx),
		});
		// `pulled.config` is already a `Config` (static auth/dataApi toggles, any
		// object-storage `preview.buckets`, and a branch tuning closure), so it feeds
		// straight into fetchEnv — no wrapping needed. pullConfig excludes functions and
		// the AI Gateway (neither can be faithfully read back), so fetchEnv never probes
		// the functions API here and only mints a storage credential when a bucket exists.
		if (!ctx.implyAiGateway) {
			return await fetchAndProject(pulled.config, ctx);
		}
		return await resolveWithImpliedGateway(pulled.config, ctx);
	}

	throw new MissingBranchContextError(
		`No project/branch context found. Link a branch (\`${getCliName()} link\` / ` +
			`\`${getCliName()} checkout\`) or pass --project-id and --branch.`,
	);
};

/** The same config with the AI Gateway enabled, leaving any other `preview` entries intact. */
const withAiGateway = (config: Config): Config => ({
	...config,
	preview: { ...config.preview, aiGateway: true },
});

/**
 * Tier-2 resolution with the AI Gateway added on top of the branch's read-back state.
 *
 * The gateway is not detectable — `pullConfig` reports no enabled flag for it — so it is
 * implied rather than observed, and a project that does not have it at all only says so when
 * the credential is minted: `createCredential` raises `PLATFORM_FEATURE_UNAVAILABLE` for a
 * project outside the regions where branch credentials exist. Failing the whole pull on that
 * would break every such project's `env pull`, so the gateway — the part that was never asked
 * for by name — is dropped, reported to the user, and reported back to the caller as
 * {@link ResolvedNeonEnvVars.skipped}. Any other error propagates.
 */
const resolveWithImpliedGateway = async (
	config: Config,
	ctx: DevEnvContext,
): Promise<ResolvedNeonEnvVars> => {
	try {
		return await fetchAndProject(withAiGateway(config), ctx);
	} catch (err) {
		if (!isFeatureUnavailable(err)) throw err;
		log.warning(
			"Skipped the AI Gateway env vars — it isn't available for this project: %s",
			err.message,
		);
		return {
			...(await fetchAndProject(config, ctx)),
			skipped: ["ai-gateway"],
		};
	}
};

const isFeatureUnavailable = (err: unknown): err is PlatformError =>
	err instanceof PlatformError && err.code === ErrorCode.FeatureUnavailable;

/**
 * Tier-0: resolve exactly the services `--service` named, with `neon.ts` out of the picture.
 *
 * The selection is checked against the branch's live state so a service that is named but not
 * provisioned fails by name, instead of quietly contributing no vars. `postgres` and the AI
 * Gateway are not checked: every branch has Postgres, and the gateway has no branch-level
 * state to check (an unavailable one surfaces when its credential is minted).
 */
const resolveSelectedServices = async (
	ctx: DevEnvContext,
	services: readonly EnvService[],
): Promise<ResolvedNeonEnvVars> => {
	const { projectId, branchId } = ctx;
	if (!projectId || !branchId) {
		throw new MissingBranchContextError(
			"--service needs a project and branch to read from. " +
				`Run \`${getCliName()} link\` and \`${getCliName()} checkout <branch>\`, or pass ` +
				"--project-id / --branch.",
		);
	}

	// Read only the services that were named, rather than going through `pullConfig`. That
	// keeps a selection independent of everything else on the branch — `pullConfig` also
	// enumerates functions and credentials, so a failure there would abort `-s auth` — and it
	// keeps an "object storage isn't available for this project" error intact, which
	// `pullConfig` degrades to an empty bucket list and would report as "no buckets".
	const api =
		ctx.api ??
		createNeonApiFromOptions("env pull --service", {
			...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
			...(ctx.apiHost ? { apiHost: ctx.apiHost } : {}),
		});
	const has = (service: EnvService): boolean => services.includes(service);
	const [auth, dataApi, buckets] = await Promise.all([
		has("auth") ? api.getNeonAuth(projectId, branchId) : null,
		has("data-api") ? readDataApi(api, projectId, branchId) : null,
		has("object-storage")
			? api.listBranchBuckets(projectId, branchId)
			: null,
	]);

	const config = configForServices(services, branchId, {
		authEnabled: auth !== null,
		dataApiEnabled: dataApi !== null,
		buckets: buckets ?? [],
	});
	// A selection resolves part of the branch, so it must not revoke: the credential its
	// persisted secrets name may also back a service it is not resolving. See
	// `fetchEnvReusingSecrets`'s `revokeSuperseded`.
	return await fetchAndProject(config, ctx, { revokeSuperseded: false });
};

/**
 * Whether the branch has a Data API integration. It is enabled per branch *and database*, so
 * this probes the same database `fetchEnv` resolves the URL from — Neon's default `neondb`,
 * else the only/first one — which is what makes the two agree. A Data API enabled on some
 * other database reads as absent.
 */
const readDataApi = async (
	api: NeonApi,
	projectId: string,
	branchId: string,
): Promise<NeonDataApiSnapshot | null> => {
	const databases = await api.listBranchDatabases(projectId, branchId);
	const database =
		databases.find((db) => db.name === "neondb") ?? databases[0];
	if (!database) return null;
	return await api.getNeonDataApi(projectId, branchId, database.name);
};

/**
 * Build the `Config` an explicit `--service` selection stands for, raising
 * {@link ServiceNotOnBranchError} for anything the branch does not have. Naming a service
 * that isn't there has to fail rather than contribute no vars, or a scoped pull would report
 * "no Neon env variables to pull" — which reads as a statement about the branch rather than
 * about the selection.
 */
const configForServices = (
	services: readonly EnvService[],
	branchId: string,
	branch: {
		authEnabled: boolean;
		dataApiEnabled: boolean;
		buckets: NeonBucketSnapshot[];
	},
): Config => {
	const notOnBranch = (service: EnvService, what: string): never => {
		throw new ServiceNotOnBranchError(
			`--service ${service}: branch ${branchId} has no ${what}, so there are no ` +
				`${service} env vars to pull. Provision it first (\`${getCliName()} deploy\`, ` +
				`\`${getCliName()} config apply\`, or the Neon Console), or drop ${service} from --service.`,
		);
	};

	const config: Config = {};
	if (services.includes("auth")) {
		if (!branch.authEnabled) notOnBranch("auth", "Neon Auth integration");
		config.auth = true;
	}
	if (services.includes("data-api")) {
		if (!branch.dataApiEnabled) {
			notOnBranch("data-api", "Data API integration");
		}
		config.dataApi = true;
	}

	const preview: NonNullable<Config["preview"]> = {};
	if (services.includes("object-storage")) {
		if (branch.buckets.length === 0) {
			notOnBranch("object-storage", "object-storage buckets");
		}
		preview.buckets = Object.fromEntries(
			branch.buckets.map((bucket) => [
				bucket.name,
				{ access: bucket.accessLevel },
			]),
		);
	}
	if (services.includes("ai-gateway")) preview.aiGateway = true;
	if (Object.keys(preview).length > 0) config.preview = preview;

	return config;
};

/**
 * The outcome of {@link resolveDevEnv}: the resolved Neon branch vars plus, when none could
 * be injected, a calm and actionable `skipped` reason for the dev server to surface. We
 * return the reason rather than logging it here so the imperative shell (`neon dev`) can
 * present it in context (in the banner, next to the URLs) — keeping this resolver a pure
 * "compute what env we have" function.
 */
export type DevEnvResolution = {
	/** Neon branch env vars to inject (DATABASE_URL[_UNPOOLED], NEON_AUTH_BASE_URL, …). */
	vars: Record<string, string>;
	/** What happened to the branch credential, when one was involved. */
	credential?: CredentialOutcome;
	/**
	 * Present only when `vars` is empty *because* resolution was skipped/degraded (not when
	 * the branch legitimately has no extra services). A short, actionable explanation.
	 */
	skipped?: { reason: string };
};

/**
 * `neon dev`'s env resolver: {@link resolveNeonEnvVars} with graceful degradation.
 *
 * - Success → `{ vars }` (possibly just the always-present Postgres URLs).
 * - No linked branch / project → `{ vars: {}, skipped }` with a "link a branch" hint; the
 *   function still runs locally, just without Neon env.
 * - Any other failure (offline, transient API error) → `{ vars: {}, skipped }` naming the
 *   cause; again non-fatal.
 * - {@link DevEnvMismatchError} (policy declares a secret-bearing service the branch lacks)
 *   is the one hard stop and is re-thrown for the caller to surface.
 */
export const resolveDevEnv = async (
	ctx: DevEnvContext,
): Promise<DevEnvResolution> => {
	try {
		const { vars, credential } = await resolveNeonEnvVars(ctx);
		return { vars, credential };
	} catch (err) {
		if (err instanceof DevEnvMismatchError) throw err;
		if (err instanceof MissingBranchContextError) {
			log.debug("dev: %s; skipping env injection", err.message);
			return {
				vars: {},
				skipped: {
					reason:
						`no linked Neon branch — run \`${getCliName()} link\`, then ` +
						`\`${getCliName()} checkout <branch>\`, to inject DATABASE_URL and friends`,
				},
			};
		}
		const detail = err instanceof Error ? err.message : String(err);
		log.debug("dev: env resolution failed: %s", detail);
		return {
			vars: {},
			skipped: {
				reason: `could not reach Neon (${detail}); running without Neon env`,
			},
		};
	}
};

/**
 * Return the policy with its `preview.functions` removed, so the env path never enumerates
 * functions against the Neon API. Functions are local-source-bundled and produce no
 * branch-level secrets, so they are irrelevant to env resolution; probing them only risks
 * failing the whole resolve (undeployed function, or Functions Preview disabled on the
 * project). Buckets / AI Gateway and the top-level Auth / Data API toggles are preserved —
 * they DO carry env, so they must still be checked and resolved. Returns the config
 * unchanged when it declares no functions.
 */
const withoutPreviewFunctions = (config: Config): Config => {
	const preview = config.preview;
	if (!preview?.functions) return config;
	const previewWithoutFunctions = { ...preview };
	delete previewWithoutFunctions.functions;
	return { ...config, preview: previewWithoutFunctions };
};

/**
 * Tier-1 guard. Dry-run the policy against the branch's live state and stop if
 * it declares a branch-level resource the branch is missing. Built on `plan` so
 * it covers every present and future provisionable resource for free: any
 * `create` action is a resource `neonctl deploy` would provision.
 *
 * Called with functions already stripped (see {@link withoutPreviewFunctions}), so the
 * `plan` probe never enumerates the functions API — an undeployed function, or a project
 * without the Functions Preview, must never block local dev or sink env injection.
 */
const assertPolicyMatchesBranch = async (
	config: Config,
	ctx: DevEnvContext,
): Promise<void> => {
	const result = await plan(config, {
		projectId: ctx.projectId as string,
		branchId: ctx.branchId as string,
		...apiOptions(ctx),
	});

	const missing = result.applied.filter(isMissingResource);
	if (missing.length === 0) return;

	const names = missing.map((change) => change.identifier).join(", ");
	throw new DevEnvMismatchError(
		`Your neon.ts declares ${names} for branch ${ctx.branchId}, but the branch ` +
			"does not have it yet, so the matching env vars cannot be injected. " +
			`Provision it first with \`${getCliName()} deploy\` (or \`${getCliName()} config apply\`), ` +
			`then re-run \`${getCliName()} dev\`.`,
	);
};

/**
 * A planned change that provisions a branch-level resource the branch lacks: a
 * `create` on a service (Neon Auth, Data API, a bucket, the AI Gateway). Branch
 * setting drift (`update`) and `noop`s are ignored — they don't block local dev
 * — and functions are excluded (see {@link assertPolicyMatchesBranch}).
 */
const isMissingResource = (change: AppliedChange): boolean =>
	change.kind === "service" &&
	change.action === "create" &&
	!change.identifier.startsWith("function:");

const fetchAndProject = async (
	config: Config,
	ctx: DevEnvContext,
	opts: { revokeSuperseded?: boolean } = {},
): Promise<ReusedBranchEnv> =>
	fetchEnvReusingSecrets(config, {
		projectId: ctx.projectId as string,
		branch: ctx.branchId as string,
		...apiOptions(ctx),
		...(ctx.env ? { env: ctx.env } : {}),
		...(opts.revokeSuperseded === false ? { revokeSuperseded: false } : {}),
	});

/**
 * Load a `neon.ts` policy if one exists on the path from `cwd` up to the repo
 * root. Returns `null` when there is none (the common "no config" case), and
 * surfaces real load errors (e.g. a syntax error in an existing file).
 */
/**
 * Substrings that mark a module-resolution failure while loading `neon.ts` —
 * almost always because the project's dependencies aren't installed yet (the
 * config imports `@neon/config` & friends). Deliberately specific:
 * the generic "…or a missing dependency…" hint the loader always appends is
 * NOT in here, so a real syntax/runtime error doesn't get mislabeled.
 */
const MISSING_DEPENDENCY_HINTS = [
	"cannot find module",
	"cannot find package",
	"err_module_not_found",
	"failed to resolve",
	"could not resolve",
	"module not found",
];

/** Flatten an error and its `cause` chain to one lowercased string for matching. */
const errorChainText = (err: unknown): string => {
	const parts: string[] = [];
	let current: unknown = err;
	for (let depth = 0; current instanceof Error && depth < 6; depth++) {
		parts.push(current.message);
		current = (current as { cause?: unknown }).cause;
	}
	return parts.join("\n").toLowerCase();
};

const looksLikeMissingDependency = (err: unknown): boolean => {
	const text = errorChainText(err);
	return MISSING_DEPENDENCY_HINTS.some((hint) => text.includes(hint));
};

const loadNeonConfig = async (cwd: string): Promise<Config | null> => {
	try {
		const { config } = await loadConfigFromFile({ cwd });
		return config;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (/Could not find a Neon config file/i.test(message)) {
			return null;
		}
		// A neon.ts that imports a package which isn't installed fails here with a
		// cryptic "Cannot find module …". Turn that into the actionable thing to do.
		if (looksLikeMissingDependency(err)) {
			throw new Error(
				"Could not load neon.ts: a package it imports is not installed. " +
					"Did you run `npm install`? Install your dependencies " +
					"(npm / pnpm / yarn / bun), then try again.\n" +
					`Original error: ${message}`,
			);
		}
		throw err;
	}
};
