import {
	type Config,
	createNeonApiFromOptions,
	ErrorCode,
	isPlatformError,
	loadConfigFromFile,
	type NeonApi,
	type NeonBucketSnapshot,
	type NeonDataApiSnapshot,
} from "@neon/config";
import { type AppliedChange, plan, pullConfig } from "@neon/config-runtime";
import {
	type FunctionUrlMode,
	functionBaseUrlKey,
	NEON_ENV_VAR_KEYS,
} from "@neon-internals/env-core/env";
import {
	type CredentialOutcome,
	fetchEnvReusingSecrets,
	type ReusedBranchEnv,
} from "@neon-internals/env-core/reuse-secrets";
import {
	ENV_PULL_SERVICES,
	type EnvPullKey,
	envKeysForSelection,
	serviceForEnvKey,
	servicesForEnvKeys,
} from "../env_services.js";
import { log } from "../log.js";
import type { NeonService } from "../neon_services.js";
import { getCliName } from "../utils/cli_name.js";
import {
	formatInstallCommand,
	resolvePackageManager,
} from "../utils/package_manager.js";

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
	services?: readonly NeonService[];
	/**
	 * Resolve exactly these OS-level env vars. Like {@link DevEnvContext.services}, this is
	 * an explicit selection that ignores `neon.ts`; when both are present their output is
	 * the union of complete service bundles and these individual keys.
	 */
	envKeys?: readonly EnvPullKey[];
	/**
	 * Add the AI Gateway to the **no-`neon.ts`** resolution. `pullConfig` cannot detect the
	 * gateway — it has no branch-level enabled state, only branch-credential capability — so
	 * a caller that wants it in the "everything this branch has" set has to ask. `neon env
	 * pull` does; `neon dev` and the pull bundled into `link` / `checkout` / `apply` do not.
	 * Ignored when {@link DevEnvContext.services} is set, since that selection already says.
	 */
	implyAiGateway?: boolean;
	/** Env pull needs function slugs even when their runtime secrets are unset. */
	omitUnsetFunctionEnv?: boolean;
};

/** The API-targeting options every runtime call forwards from the context. */
const apiOptions = (ctx: DevEnvContext) => ({
	...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
	...(ctx.apiHost ? { apiHost: ctx.apiHost } : {}),
	...(ctx.api ? { api: ctx.api } : {}),
});

/** Policy mismatches hard-stop because running without declared env vars violates user intent. */
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
 * Thrown when an explicit `--service` / `--env` selection needs a service the branch lacks.
 * Unlike the policy path — where the same situation is a {@link DevEnvMismatchError} pointing
 * at `deploy` — the user named the service on the command line, so the fix is to provision it
 * or drop it from the selection.
 */
export class ServiceNotOnBranchError extends Error {
	override readonly name = "ServiceNotOnBranchError";
}

/** What {@link resolveNeonEnvVars} produced, and what it could not. */
export type ResolvedNeonEnvVars = ReusedBranchEnv & {
	/** Keeps implicit resolution failures visible while explicit selections fail directly. */
	skipped?: readonly NeonService[];
};

/**
 * Resolve the branch's Neon env vars (pooled / direct `DATABASE_URL`, plus Auth /
 * Data API when enabled) into a `{ KEY: value }` map. Shared by `neon dev` (which
 * injects them) and `neon env pull` (which writes them to a `.env` file).
 *
 * Tiered:
 *
 *   0. {@link DevEnvContext.services} or {@link DevEnvContext.envKeys} is set -> that
 *      selection *is* the policy, and any `neon.ts` is ignored. See
 *      {@link resolveSelectedServices}.
 *   1. a `neon.ts` policy is found -> the policy is the source of truth. We first
 *      check it against the branch's live state (`plan`); if it declares a resource
 *      the branch is missing, we stop with a {@link DevEnvMismatchError} pointing at
 *      `neonctl deploy`. Function declarations are excluded from that check: their
 *      invocation URLs are derived from the branch connection host, so an undeployed
 *      function still gets `NEON_FUNCTION_*_BASE_URL`. Otherwise `fetchEnv` evaluates
 *      the policy.
 *   2. no `neon.ts`, but a project + branch are known -> `pullConfig` reads the
 *      branch's live state (Auth / Data API enablement plus any object-storage
 *      buckets) into a config, then `fetchEnv` resolves what is actually enabled —
 *      so a branch with a bucket gets its `AWS_*` storage vars pulled with no policy.
 *      Function invocation URLs are listed live (`functionUrls: "all-live"`) because
 *      `pullConfig` cannot round-trip them into `preview.functions`. With
 *      {@link DevEnvContext.implyAiGateway}, the AI Gateway is added on top, since
 *      `pullConfig` cannot read it back.
 *   3. otherwise -> throw {@link MissingBranchContextError}.
 *
 * Unlike {@link resolveDevEnv}, this never swallows errors — callers decide how to
 * handle them.
 */
export const resolveNeonEnvVars = async (
	ctx: DevEnvContext,
): Promise<ResolvedNeonEnvVars> => {
	if (ctx.services !== undefined || ctx.envKeys !== undefined) {
		return await resolveSelectedServices(
			ctx,
			ctx.services ?? [],
			ctx.envKeys ?? [],
		);
	}

	const config = await loadNeonConfig(ctx);

	if (config) {
		if (!ctx.projectId || !ctx.branchId) {
			throw new MissingBranchContextError(
				"Found a neon.ts but could not resolve the project/branch. " +
					`Run \`${getCliName()} link\` and \`${getCliName()} checkout <branch>\`, or pass ` +
					"--project-id / --branch.",
			);
		}
		await assertPolicyMatchesBranch(withoutPreviewFunctions(config), ctx);
		return await fetchAndProject(config, ctx);
	}

	if (ctx.projectId && ctx.branchId) {
		const pulled = await pullConfig({
			projectId: ctx.projectId,
			branchId: ctx.branchId,
			...apiOptions(ctx),
		});
		// pullConfig cannot represent function declarations, so branch read-back must list all
		// live URLs. The AI Gateway remains separate because it has no read-back state.
		if (!ctx.implyAiGateway) {
			return await fetchAndProject(pulled.config, ctx, {
				functionUrls: "all-live",
			});
		}
		return await resolveWithImpliedGateway(pulled.config, ctx, {
			projectId: ctx.projectId,
			branchId: ctx.branchId,
		});
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
 * implied rather than observed. Nobody named it, so it must never be the reason the whole
 * resolve fails: a project outside the regions where branch credentials exist would otherwise
 * lose its `DATABASE_URL` too, and `neon dev` would start with no env at all.
 *
 * So the gateway is only added once its credential endpoint has been shown to answer, by
 * reading the branch's credentials first. A project that does not have them says so on a
 * read, before anything is minted — which is the whole question, since the gateway's env is a
 * credential and nothing else.
 *
 * Deciding this **before** resolving, rather than by catching and retrying, is what keeps it
 * honest. A retry re-runs every call the first attempt made, so it would blame the gateway for
 * a one-off failure in shared work, and — worse — a first attempt that minted a credential and
 * then failed would be papered over by a second that succeeds without one, swallowing the
 * error and stranding a secret nobody holds. Once the read succeeds, a later failure is a real
 * failure and propagates: the same thing already happens on a branch with object storage,
 * whose credential is minted whether or not the gateway is involved.
 */
const resolveWithImpliedGateway = async (
	config: Config,
	ctx: DevEnvContext,
	/** Resolved by the caller, which is the branch this env belongs to. */
	branch: { projectId: string; branchId: string },
): Promise<ResolvedNeonEnvVars> => {
	const unreachable = await credentialsUnreachable(ctx, branch);
	if (unreachable === null) {
		return await fetchAndProject(withAiGateway(config), ctx, {
			functionUrls: "all-live",
		});
	}
	// Deliberately does not assert that the project lacks the gateway: a read can also fail
	// for a reason that has nothing to do with the feature, and this is not the place to
	// guess which. Name both, and the command that answers it.
	log.warning(
		"Could not reach the AI Gateway's credentials, so %s were not resolved. Everything " +
			"else was. Either this project does not have the AI Gateway, or the call failed — " +
			`\`${getCliName()} env pull -s ai-gateway\` will say which.\nDetails: %s`,
		[
			NEON_ENV_VAR_KEYS.aiGateway.apiKey,
			NEON_ENV_VAR_KEYS.aiGateway.baseUrl,
		].join(" and "),
		unreachable,
	);
	const pulled = await fetchAndProject(config, ctx, {
		functionUrls: "all-live",
	});
	return {
		...pulled,
		skipped: [...(pulled.skipped ?? []), "ai-gateway"],
	};
};

/**
 * Why the branch's credentials could not be read, or `null` when they could. A plain read: it
 * mints nothing, revokes nothing, and changes nothing, so asking is free of the side effects
 * that make a failed resolve ambiguous.
 */
const credentialsUnreachable = async (
	ctx: DevEnvContext,
	branch: { projectId: string; branchId: string },
): Promise<string | null> => {
	try {
		await apiFor(ctx).listCredentials(branch.projectId, branch.branchId);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
};

/** The adapter for direct branch reads: the injected one in tests, else built from options. */
const apiFor = (ctx: DevEnvContext): NeonApi =>
	ctx.api ??
	createNeonApiFromOptions("neon env", {
		...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
		...(ctx.apiHost ? { apiHost: ctx.apiHost } : {}),
	});

/**
 * Tier-0: resolve exactly what `--service` / `--env` selected, with `neon.ts` ignored.
 *
 * The selection is checked against live project and branch state so a service that is named
 * but not provisioned fails by name, instead of quietly contributing dead vars. `postgres`
 * needs no check because every branch has it.
 */
const resolveSelectedServices = async (
	ctx: DevEnvContext,
	directServices: readonly NeonService[],
	envKeys: readonly EnvPullKey[],
): Promise<ResolvedNeonEnvVars> => {
	const { projectId, branchId } = ctx;
	if (!projectId || !branchId) {
		throw new MissingBranchContextError(
			"An explicit env selection needs a project and branch to read from. " +
				`Run \`${getCliName()} link\` and \`${getCliName()} checkout <branch>\`, or pass ` +
				"--project-id / --branch.",
		);
	}
	const impliedServices = servicesForEnvKeys(envKeys);
	const services = ENV_PULL_SERVICES.filter(
		(service) =>
			directServices.includes(service) ||
			impliedServices.includes(service),
	);
	const selectedKeys = envKeysForSelection(directServices, envKeys);

	// Read only the services that were named, rather than going through `pullConfig`. That
	// keeps a selection independent of everything else on the branch — `pullConfig` also
	// enumerates functions and credentials, so a failure there would abort `-s auth` — and it
	// keeps an "object storage isn't available for this project" error intact, which
	// `pullConfig` degrades to an empty bucket list and would report as "no buckets".
	const api = apiFor(ctx);
	const has = (service: (typeof ENV_PULL_SERVICES)[number]): boolean =>
		services.includes(service);
	const checkAiGateway =
		has("ai-gateway") &&
		!selectedKeys.includes(NEON_ENV_VAR_KEYS.aiGateway.apiKey);
	const [auth, dataApiEnabled, buckets, aiGatewayAvailable, functions] =
		await Promise.all([
			has("auth") ? api.getNeonAuth(projectId, branchId) : null,
			has("data-api")
				? readDataApiEnabled(api, projectId, branchId)
				: null,
			has("object-storage")
				? api.listBranchBuckets(projectId, branchId)
				: null,
			checkAiGateway
				? readAiGatewayAvailable(api, projectId, branchId)
				: null,
			directServices.includes("functions")
				? api.listBranchFunctions(projectId, branchId)
				: null,
		]);

	const callableFunctions = (functions ?? []).filter(
		(fn) => fn.invocationUrl !== "",
	);
	if (
		directServices.includes("functions") &&
		callableFunctions.length === 0
	) {
		throw new ServiceNotOnBranchError(
			`--service functions: branch ${branchId} has no deployed functions, so there ` +
				"are no NEON_FUNCTION_*_BASE_URL vars to pull. Deploy a function first " +
				`(\`${getCliName()} deploy\`, or in the Neon Console), or drop functions from --service.`,
		);
	}

	const functionKeys = directServices.includes("functions")
		? callableFunctions
				.map((fn) => functionBaseUrlKey(fn.slug))
				.sort((left, right) => left.localeCompare(right))
		: [];
	const fetchKeys = [...new Set([...selectedKeys, ...functionKeys])];

	const config = configForServices(
		services,
		branchId,
		{
			authEnabled: auth !== null,
			dataApiEnabled,
			buckets: buckets ?? [],
			// A token selection validates availability while minting. The read-only check is
			// needed only when the base URL was selected on its own.
			aiGatewayAvailable: aiGatewayAvailable ?? true,
		},
		{ directServices, envKeys },
	);
	// A selection resolves part of the branch, so it must not revoke: the credential its
	// persisted secrets name may also back a service it is not resolving. See
	// `fetchEnvReusingSecrets`'s `revokeSuperseded`.
	return await fetchAndProject(config, ctx, {
		keys: fetchKeys,
		revokeSuperseded: false,
		...(directServices.includes("functions")
			? {
					functionUrls: "all-live" as const,
					listedFunctions: callableFunctions,
				}
			: {}),
	});
};

/**
 * Whether the branch has a Data API integration — or `null` when that cannot be determined.
 *
 * It is enabled per branch *and database*, so this has to probe the database `fetchEnv` will
 * resolve the URL from, or the two would disagree. That is Neon's default `neondb`, else the
 * only database; several databases with no `neondb` is a case `fetchEnv` refuses to auto-pick
 * at all. Reporting "no Data API integration" there would be a claim this read cannot support,
 * so it answers `null` and lets `fetchEnv` raise its own ambiguity error, which names the
 * databases and the fix.
 */
const readDataApiEnabled = async (
	api: NeonApi,
	projectId: string,
	branchId: string,
): Promise<boolean | null> => {
	const databases = await api.listBranchDatabases(projectId, branchId);
	const database =
		databases.find((db) => db.name === NEON_DEFAULT_DATABASE) ??
		(databases.length === 1 ? databases[0] : undefined);
	if (!database) return databases.length === 0 ? false : null;
	const dataApi: NeonDataApiSnapshot | null = await api.getNeonDataApi(
		projectId,
		branchId,
		database.name,
	);
	return dataApi !== null;
};

const readAiGatewayAvailable = async (
	api: NeonApi,
	projectId: string,
	branchId: string,
): Promise<boolean> => {
	try {
		await api.listCredentials(projectId, branchId);
		return true;
	} catch (error) {
		if (
			isPlatformError(error) &&
			error.code === ErrorCode.FeatureUnavailable &&
			(error.details.status === 404 || error.details.status === 501)
		) {
			return false;
		}
		throw error;
	}
};

/** Neon's default database, and the one `fetchEnv` prefers when a branch has several. */
const NEON_DEFAULT_DATABASE = "neondb";

/**
 * Build the `Config` an explicit `--service` / `--env` selection stands for, raising
 * {@link ServiceNotOnBranchError} for anything the branch does not have. Naming a service
 * that isn't there has to fail rather than contribute no vars, or a scoped pull would report
 * "no Neon env variables to pull" — which reads as a statement about the branch rather than
 * about the selection.
 */
const configForServices = (
	services: readonly NeonService[],
	branchId: string,
	branch: {
		authEnabled: boolean;
		/** `null` when the read could not decide — see {@link readDataApiEnabled}. */
		dataApiEnabled: boolean | null;
		buckets: NeonBucketSnapshot[];
		aiGatewayAvailable: boolean;
	},
	selection: {
		directServices: readonly NeonService[];
		envKeys: readonly EnvPullKey[];
	},
): Config => {
	// The command that provisions each one, for a user who may well have no `neon.ts` — in
	// which case `deploy` / `config apply` would be no help at all.
	const provisionWith: Record<string, string> = {
		auth: `${getCliName()} neon-auth enable`,
		"data-api": `${getCliName()} data-api create`,
		"object-storage": `${getCliName()} buckets create <name>`,
	};
	const notOnBranch = (service: NeonService, what: string): never => {
		if (!selection.directServices.includes(service)) {
			const keys = selection.envKeys.filter(
				(key) => serviceForEnvKey(key) === service,
			);
			const names = keys.join(", ");
			throw new ServiceNotOnBranchError(
				`--env ${names}: branch ${branchId} has no ${what}, so ${names} cannot be pulled. ` +
					`Provision it first (\`${provisionWith[service]}\`, or in the Neon Console), ` +
					`or drop ${names} from --env.`,
			);
		}
		throw new ServiceNotOnBranchError(
			`--service ${service}: branch ${branchId} has no ${what}, so there are no ` +
				`${service} env vars to pull. Provision it first (\`${provisionWith[service]}\`, ` +
				`or in the Neon Console), or drop ${service} from --service.`,
		);
	};
	const aiGatewayUnavailable = (): never => {
		const reason =
			"AI Gateway is not available for this Neon project because branch credentials are unavailable";
		if (selection.directServices.includes("ai-gateway")) {
			throw new ServiceNotOnBranchError(
				`--service ai-gateway: ${reason}. Use another project, or drop ai-gateway from --service.`,
			);
		}
		const names = selection.envKeys
			.filter((key) => serviceForEnvKey(key) === "ai-gateway")
			.join(", ");
		throw new ServiceNotOnBranchError(
			`--env ${names}: ${reason}, so ${names} cannot be pulled. ` +
				`Use another project, or drop ${names} from --env.`,
		);
	};

	const config: Config = {};
	if (services.includes("auth")) {
		if (!branch.authEnabled) notOnBranch("auth", "Neon Auth integration");
		config.auth = true;
	}
	if (services.includes("data-api")) {
		// Only a positive "not there" is an error; an undecidable read defers to `fetchEnv`.
		if (branch.dataApiEnabled === false) {
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
	if (services.includes("ai-gateway")) {
		if (!branch.aiGatewayAvailable) aiGatewayUnavailable();
		preview.aiGateway = true;
	}
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

/** Functions are omitted because `plan` treats undeployed functions as resources to create. */
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
	opts: {
		keys?: readonly string[];
		revokeSuperseded?: boolean;
		functionUrls?: FunctionUrlMode;
		listedFunctions?: ReadonlyArray<{
			slug: string;
			invocationUrl: string;
		}>;
	} = {},
): Promise<ResolvedNeonEnvVars> => {
	const result = await fetchEnvReusingSecrets(config, {
		projectId: ctx.projectId as string,
		branch: ctx.branchId as string,
		...apiOptions(ctx),
		...(ctx.env ? { env: ctx.env } : {}),
		...(opts.keys ? { keys: opts.keys } : {}),
		...(opts.revokeSuperseded === false ? { revokeSuperseded: false } : {}),
		...(opts.functionUrls ? { functionUrls: opts.functionUrls } : {}),
		...(opts.listedFunctions
			? { listedFunctions: opts.listedFunctions }
			: {}),
	});
	return {
		vars: result.vars,
		credential: result.credential,
		...(result.functionUrlsUnavailable ? { skipped: ["functions"] } : {}),
	};
};

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

const loadNeonConfig = async (ctx: DevEnvContext): Promise<Config | null> => {
	try {
		const { config } = await loadConfigFromFile({
			cwd: ctx.cwd,
			...(ctx.omitUnsetFunctionEnv
				? { unsetFunctionEnv: "omit" as const }
				: {}),
		});
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
					`Run \`${formatInstallCommand(resolvePackageManager(ctx.cwd))}\`, then try again.\n` +
					`Original error: ${message}`,
			);
		}
		throw err;
	}
};
