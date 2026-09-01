import { existsSync } from "node:fs";
import type { NeonApi } from "@neon/config";
import {
	isFunctionBaseUrlKey,
	NEON_ENV_VAR_KEYS,
} from "@neon-internals/env-core/env";
import type { CredentialOutcome } from "@neon-internals/env-core/reuse-secrets";
import chalk from "chalk";
import type yargs from "yargs";
import { ensureGitignored } from "../context.js";
import { resolveNeonEnvVars } from "../dev/env.js";
import { mergeEnvFile, readEnvFile, resolveEnvFilePath } from "../env_file.js";
import {
	ENV_PULL_KEY_HELP,
	ENV_PULL_SERVICES,
	type EnvPullKey,
	envKeysForSelection,
	envPullFlagValue,
	ownedEnvServiceKeys,
	parseEnvPullKeys,
} from "../env_services.js";
import { log } from "../log.js";
import {
	deprecatedServiceMessage,
	type NeonService,
	parseServices,
	servicesFlagValue,
	servicesOption,
} from "../neon_services.js";
import type { BranchScopeProps } from "../types.js";
import { warnAiGateway } from "../utils/ai_gateway_notice.js";
import { announceTargetBranch } from "../utils/branch_notice.js";
import { getCliName } from "../utils/cli_name.js";
import { fillSingleProject, resolveBranchRef } from "../utils/enrichers.js";

export type EnvPullProps = BranchScopeProps & {
	/** Target dotenv file. Defaults to an existing `.env`, else `.env.local`. */
	file?: string;
	/** Working directory to resolve neon.ts / write the .env file in. Defaults to cwd (tests). */
	cwd?: string;
	/** Injected NeonApi adapter (tests). Production builds it from credentials. */
	runtimeApi?: NeonApi;
	/**
	 * Pull only these services' env vars, ignoring any `neon.ts` (`--service`). The pull is
	 * then scoped in both directions: it writes only these services' vars, and prunes only
	 * within them.
	 */
	services?: readonly NeonService[];
	/**
	 * Pull exactly these OS-level env vars (`--env`). Combined with `services` as a union:
	 * complete service bundles plus these individual keys.
	 */
	envKeys?: readonly EnvPullKey[];
};

export const command = "env";
export const describe = "Manage a branch's Neon env variables locally";

/**
 * Shown (to stderr) when `link` / `checkout` skip the bundled env pull because the user passed
 * `--no-env-pull`. Names the two ways to get the branch's vars without an on-disk file written
 * eagerly: an explicit `neonctl env pull`, or runtime injection via `neon-env run`.
 */
export const ENV_PULL_SKIPPED_HINT =
	`Skipped env pull (--no-env-pull). Run \`${getCliName()} env pull\` to write this branch’s env vars ` +
	"(DATABASE_URL, …) into a local .env, or inject them at runtime with `neon-env run -- <your dev command>`.";
export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 env <sub-command> [options]")
		.options({
			"project-id": { describe: "Project ID", type: "string" },
			branch: { describe: "Branch ID or name", type: "string" },
		})
		.middleware(fillSingleProject as any)
		.command(
			"pull",
			"Write the branch's Neon env variables to a local .env file",
			(yargs) =>
				yargs
					.usage("$0 env pull [options]")
					.options({
						file: {
							describe:
								"Target .env file to write. Defaults to an existing .env, " +
								"otherwise .env.local. Only Neon variables are updated; other " +
								"lines are preserved.",
							type: "string",
						},
						service: servicesOption({
							key: "service",
							allowed: ENV_PULL_SERVICES,
							describe: "Pull only these services' variables",
							also:
								"Overrides neon.ts, and prunes only within the services you name. " +
								"Combines with --env as a union.",
						}),
						env: {
							alias: "e",
							describe:
								`Pull only these individual variables: ${ENV_PULL_KEY_HELP}. ` +
								"Repeat the flag or comma-separate. Overrides neon.ts. Combines " +
								"with --service as a union; it never narrows a service bundle.",
							type: "array",
							string: true,
						},
					})
					.epilogue(
						[
							"",
							"What gets pulled, in precedence order:",
							"  1. --service / --env, when given — their union, ignoring neon.ts.",
							"  2. neon.ts, when this directory has one — including derived function",
							"     URLs (the function does not have to be deployed).",
							"  3. Otherwise everything the branch has, plus the AI Gateway —",
							"     which mints a branch credential for it.",
							"",
							"The pull bundled into link / checkout / config apply follows 2 and 3",
							"without the AI Gateway, so it never mints a credential you did not ask",
							"for. Run `env pull` to add it.",
						].join("\n"),
					)
					.example(
						"$0 env pull",
						"Write the linked branch's Neon vars into .env.local (or .env if present)",
					)
					.example(
						"$0 env pull --branch preview --file .env.preview",
						"Pull a specific branch into a specific file",
					)
					.example(
						"$0 env pull -s ai-gateway -s postgres",
						"Pull only the AI Gateway and Postgres variables",
					)
					.example(
						"$0 env pull -e DATABASE_URL",
						"Pull only the pooled Postgres connection string",
					)
					.example(
						"$0 env pull -s auth -e DATABASE_URL",
						"Pull all Auth variables plus DATABASE_URL",
					)
					.example(
						"$0 env pull -s functions",
						"Pull NEON_FUNCTION_<SLUG>_BASE_URL for every deployed function",
					)
					.example(
						"$0 env pull -e NEON_FUNCTION_HELLO_BASE_URL",
						"Write that function's production invocation URL (no deploy required)",
					)
					.strict(),
			async (args) => {
				const rawServices = servicesFlagValue(args.service);
				const rawEnvKeys = envPullFlagValue(args.env);
				const services = rawServices
					? parseServices(rawServices, {
							allowed: ENV_PULL_SERVICES,
							flag: "--service",
							onDeprecated: (used, canonical) =>
								log.warning(
									deprecatedServiceMessage(used, canonical),
								),
						})
					: undefined;
				const envKeys = rawEnvKeys
					? parseEnvPullKeys(rawEnvKeys, "--env")
					: undefined;
				// Explicit `env pull` announces the branch it's reading from up front so the user
				// can catch "pulled env from the wrong branch" before it overwrites their .env. The
				// bundled auto-pull (link / checkout / apply) stays quiet — those already report the
				// branch they pinned/applied to.
				//
				// It also implies the AI Gateway when there is no neon.ts, so a bare `env pull`
				// really does write everything the branch can give you. The bundled auto-pull does
				// not: minting a credential for a service the user never named is not something a
				// side effect of `link` / `checkout` / `apply` should do.
				await pull(
					{
						...(args as any),
						...(services ? { services } : {}),
						...(envKeys ? { envKeys } : {}),
					},
					{
						announce: true,
						implyAiGateway:
							rawServices === undefined &&
							rawEnvKeys === undefined,
					},
				);
			},
		)
		.demandCommand(1);

export const handler = (args: yargs.Argv) => args;

/** Every OS-level env var name `@neon/env` can emit, used only for reporting. */
const NEON_VAR_NAMES = Object.values(NEON_ENV_VAR_KEYS).flatMap((group) =>
	Object.values(group),
);

/**
 * The Neon env vars `env pull` *owns*, so it removes any that the branch no longer has when
 * it reconciles the local `.env` (see {@link pull}). Scoped to the unambiguously Neon-named
 * vars — the `NEON_*` aliases plus `DATABASE_URL[_UNPOOLED]` — so switching a working
 * directory to a project/branch without Auth / the Data API drops the now-stale
 * `NEON_AUTH_*` / `NEON_DATA_API_*` lines instead of leaving credentials for features that
 * aren't enabled.
 *
 * Deliberately **excludes** the storage vars Neon projects onto third-party SDK names
 * (`AWS_*`): those collide with credentials a user may set by hand, so `env pull` only ever
 * writes them, never prunes them. The AI Gateway is emitted solely under its Neon-branded
 * vars (`NEON_AI_GATEWAY_*`), which are owned and pruned.
 */
const NEON_OWNED_ENV_KEYS: readonly EnvPullKey[] = [
	...Object.values(NEON_ENV_VAR_KEYS.postgres),
	...Object.values(NEON_ENV_VAR_KEYS.auth),
	...Object.values(NEON_ENV_VAR_KEYS.dataApi),
	...Object.values(NEON_ENV_VAR_KEYS.aiGateway),
];

export type PullOutcome =
	| {
			status: "written";
			written: string[];
			file: string;
			/**
			 * What happened to the branch credential, when the branch has object storage or the
			 * AI Gateway. Absent otherwise — nothing else is credential-backed.
			 */
			credential?: CredentialOutcome;
			/** Marks an incomplete implicit resolve without hiding an explicit selection failure. */
			skipped?: readonly NeonService[];
	  }
	| { status: "empty" };

export const pull = async (
	props: EnvPullProps,
	opts: { announce?: boolean; implyAiGateway?: boolean } = {},
): Promise<PullOutcome> => {
	const cwd = props.cwd ?? process.cwd();
	const selectedKeys =
		props.services !== undefined || props.envKeys !== undefined
			? envKeysForSelection(props.services ?? [], props.envKeys ?? [])
			: undefined;
	const branch = await resolveBranchRef(props);
	if (opts.announce) {
		announceTargetBranch(props, branch, "Pulling env from branch");
	}
	const branchId = branch.branchId;

	// Resolve the target file first and layer its current contents under the resolver's env
	// source. This lets `fetchEnv` reuse one-time secrets that are already on disk — Neon Auth
	// keys and the unified branch credential's `api_token` / `s3_secret_access_key`, which the
	// API returns exactly once — instead of minting a fresh credential on every pull.
	const targetPath = resolveEnvFilePath(cwd, props.file);
	const fileExisted = existsSync(targetPath);
	const existingEnv = fileExisted ? readEnvFile(targetPath) : {};

	// Reuse `neon dev`'s tiered resolver (neon.ts policy -> plan gate -> fetchEnv, else
	// pullConfig -> fetchEnv). Unlike dev, an unresolved context or failure is surfaced —
	// `env pull` is an explicit action, so it should error rather than write nothing.
	const { vars, credential, skipped } = await resolveNeonEnvVars({
		cwd,
		projectId: props.projectId,
		branchId,
		env: { ...process.env, ...existingEnv },
		...(props.services ? { services: props.services } : {}),
		...(props.envKeys ? { envKeys: props.envKeys } : {}),
		...(opts.implyAiGateway ? { implyAiGateway: true } : {}),
		...(props.apiKey ? { apiKey: props.apiKey } : {}),
		...(props.apiHost ? { apiHost: props.apiHost } : {}),
		...(props.runtimeApi ? { api: props.runtimeApi } : {}),
	});

	const neonVars = pickSelectedVars(
		pickNeonVars(vars),
		selectedKeys,
		props.services,
	);
	if (Object.keys(neonVars).length === 0) {
		log.info(
			"No Neon env variables to pull for this branch (no DATABASE_URL or " +
				"enabled Auth / Data API).",
		);
		return { status: "empty" };
	}

	// Reconcile rather than blindly merge: write the branch's current Neon vars and prune any
	// Neon-owned vars the branch no longer has (e.g. NEON_AUTH_* / NEON_DATA_API_* carried over
	// from a previous project/branch). Non-Neon lines are always preserved.
	const { written, removed } = mergeEnvFile(targetPath, neonVars, {
		managedKeys: managedKeysFor(
			selectedKeys,
			unreachedButCurrent(skipped, existingEnv, branchId),
			existingEnv,
			props.services,
			props.envKeys,
		),
	});
	log.info(
		"Pulled %d Neon variable%s into %s: %s",
		written.length,
		written.length === 1 ? "" : "s",
		targetPath,
		written.join(", "),
	);
	if (removed.length > 0) {
		log.info(
			"Removed %d stale Neon variable%s not enabled on this branch: %s",
			removed.length,
			removed.length === 1 ? "" : "s",
			removed.join(", "),
		);
	}
	// A new credential means the values that back object storage / the AI Gateway just
	// changed, so anything else holding the old ones (a deployed preview, a second checkout)
	// needs the new values. Name the keys rather than leaving the user to diff the file.
	if (credential?.issued) {
		log.info(
			"Issued a new branch credential — these now hold fresh values: %s",
			credential.keys.join(", "),
		);
		if (credential.revoked.length > 0) {
			log.info(
				"Revoked the credential it replaced (%s).",
				credential.revoked.join(", "),
			);
		} else if (credential.superseded.length > 0) {
			// An unscoped pull revokes what it supersedes and says so above. A scoped one
			// cannot — it may not be the only service on that credential — so it leaves the
			// old one live. Say that too, rather than letting the identical-looking output
			// imply the branch is not accumulating credentials. Driven by what the resolver
			// actually declined to revoke, so a first pull (which supersedes nothing) does
			// not send the user hunting for a credential that was never there.
			log.info(
				"Left the credential it replaced live (%s): an explicitly scoped pull " +
					"can't tell which other variables still use it. Revoke it in the Neon " +
					"Console if nothing does.",
				credential.superseded.join(", "),
			);
		}
	}

	// A dotenv file *we* create holds live branch credentials (DATABASE_URL, Auth keys, service
	// tokens), so ignore it the same way the `.neon` context file is — otherwise a fresh repo is
	// one `git add -A` away from committing them. Only on creation: re-adding the entry on every
	// pull would fight a user who deliberately un-ignored a file they want to commit.
	if (!fileExisted) {
		ensureGitignored(targetPath);
	}

	// When the branch has the AI Gateway enabled, the pulled credentials always work, but
	// serving is plan-gated and the model set can be reduced on the beta — surface that as a
	// courtesy notice (best-effort; never fails the pull). The freshly pulled token lets us
	// probe the branch's own /v1/models to detect a reduced catalog.
	const gatewayBaseUrl = neonVars.NEON_AI_GATEWAY_BASE_URL;
	const gatewayToken = neonVars.NEON_AI_GATEWAY_TOKEN;
	if (gatewayBaseUrl && gatewayToken) {
		await warnAiGateway({
			apiClient: props.apiClient,
			projectId: props.projectId,
			branchId,
			gateway: { baseUrl: gatewayBaseUrl, token: gatewayToken },
		});
	}

	return {
		status: "written",
		written,
		file: targetPath,
		...(credential && credential.keys.length > 0 ? { credential } : {}),
		...(skipped && skipped.length > 0 ? { skipped } : {}),
	};
};

/** Prevents scoped or unavailable services from pruning values they did not resolve. */
const managedKeysFor = (
	selectedKeys: readonly EnvPullKey[] | undefined,
	unreached: readonly NeonService[],
	existingEnv: Record<string, string>,
	services: readonly NeonService[] | undefined,
	envKeys: readonly EnvPullKey[] | undefined,
): string[] => {
	const existingFunctionKeys =
		Object.keys(existingEnv).filter(isFunctionBaseUrlKey);
	const namedFunctionKeys = (envKeys ?? []).filter(isFunctionBaseUrlKey);
	const functionsInScope =
		selectedKeys === undefined ||
		(services?.includes("functions") ?? false);
	const ownedFunctionKeys = functionsInScope
		? existingFunctionKeys
		: namedFunctionKeys;
	const owned = selectedKeys
		? [
				...NEON_OWNED_ENV_KEYS.filter((key) =>
					selectedKeys.includes(key),
				),
				...ownedFunctionKeys,
			]
		: [...NEON_OWNED_ENV_KEYS, ...ownedFunctionKeys];
	if (unreached.length === 0) return owned;
	const keep = new Set(ownedEnvServiceKeys(unreached));
	return owned.filter((key) => {
		if (unreached.includes("functions") && isFunctionBaseUrlKey(key)) {
			return false;
		}
		return !keep.has(key);
	});
};

/**
 * Endpoint failure is not evidence that existing values are stale; the gateway host check
 * avoids preserving credentials for a different branch.
 */
const unreachedButCurrent = (
	skipped: readonly NeonService[] | undefined,
	existingEnv: Record<string, string>,
	branchId: string,
): NeonService[] => {
	if (!skipped) return [];
	const keep: NeonService[] = [];
	if (skipped.includes("ai-gateway")) {
		const baseUrl = existingEnv[NEON_ENV_VAR_KEYS.aiGateway.baseUrl];
		if (baseUrl !== undefined && isBranchGatewayUrl(baseUrl, branchId)) {
			keep.push("ai-gateway");
		}
	}
	if (skipped.includes("functions")) keep.push("functions");
	return keep;
};

/**
 * Whether a persisted `NEON_AI_GATEWAY_BASE_URL` addresses `branchId`'s gateway.
 *
 * Checks the parsed **hostname** against the shape `@neon/env` builds
 * (`<branchId>-api.ai.<host suffix>`), not the raw string: a prefix comparison is satisfied
 * by a URL whose userinfo carries the branch id (`https://<branchId>-api.ai.@other-host/`)
 * while the request actually goes elsewhere. An unparseable value is not this branch's
 * gateway either, which is an answer rather than a swallowed failure.
 */
const isBranchGatewayUrl = (baseUrl: string, branchId: string): boolean =>
	URL.canParse(baseUrl) &&
	new URL(baseUrl).hostname.startsWith(`${branchId}-api.ai.`);

/**
 * Narrow the resolved vars to the explicit service/key union. `fetchEnv` may resolve
 * supporting values that were not selected (the direct connection URI derives the AI Gateway
 * host, for example); those must not land in the target file.
 */
const pickSelectedVars = (
	vars: Record<string, string>,
	selectedKeys: readonly EnvPullKey[] | undefined,
	services: readonly NeonService[] | undefined,
): Record<string, string> => {
	if (!selectedKeys) return vars;
	const wanted = new Set<string>(selectedKeys);
	const keepFunctionUrls = services?.includes("functions") ?? false;
	return Object.fromEntries(
		Object.entries(vars).filter(
			([key]) =>
				wanted.has(key) ||
				(keepFunctionUrls && isFunctionBaseUrlKey(key)),
		),
	);
};

/**
 * Outcome of the env pull that `link` / `checkout` run automatically once a branch is pinned.
 * Adds the two non-`pull` cases: the user opted out (`--no-env-pull`), or the pull failed (and
 * was degraded to a warning so the pin still stands).
 */
export type AutoPullResult =
	| PullOutcome
	| { status: "skipped" }
	| { status: "failed"; message: string };

/**
 * Pull a freshly-pinned branch's Neon env vars into a local `.env`, bundled into `link` and
 * `checkout` so the branch-first loop is just *link + checkout* — `env pull` runs for you.
 *
 * On by default; `--no-env-pull` opts out (e.g. when env is injected at runtime via
 * `neon-env run` / `neon dev`, or to keep secrets out of the working tree). The pin is the
 * command's primary effect and has already succeeded by the time this runs, so a pull failure
 * degrades to a warning rather than failing the command.
 */
export const autoPullEnvAfterPin = async (
	props: EnvPullProps & { envPull: boolean },
): Promise<AutoPullResult> => {
	if (!props.envPull) {
		log.info(chalk.dim(ENV_PULL_SKIPPED_HINT));
		return { status: "skipped" };
	}
	try {
		return await pull(props);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.warning(
			"Branch pinned, but pulling its Neon env vars failed: %s\n" +
				`Run \`${getCliName()} env pull\` once resolved (e.g. \`${getCliName()} deploy\` if a declared service ` +
				"is missing), or inject them at runtime with `neon-env run -- <your dev command>`.",
			message,
		);
		return { status: "failed", message };
	}
};

/**
 * Keep only the recognized Neon variables from the resolved set, so a stray inherited
 * value never lands in the user's `.env` file. (Today `resolveNeonEnvVars` only emits Neon
 * vars, but filtering keeps the contract explicit and future-proof.)
 */
const pickNeonVars = (vars: Record<string, string>): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(vars)) {
		if (
			NEON_VAR_NAMES.some((key) => key === name) ||
			isFunctionBaseUrlKey(name)
		) {
			out[name] = value;
		}
	}
	return out;
};
