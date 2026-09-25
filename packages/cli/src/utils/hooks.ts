import type {
	CheckoutEvent,
	Config,
	DeployEvent,
	GitContext,
	HookBranch,
	HookEnv,
	Hooks,
	PushResult,
} from "@neon/config";
import { loadConfigFromFile, runHook } from "@neon/config-runtime";
import {
	type FetchEnvKeysOptions,
	fetchEnvKeys,
	type ResolvedNeonEnv,
} from "@neon-internals/env-core/env";

import type { NeonApiClient } from "../api.js";
import { log } from "../log.js";

/**
 * Load the nearest `neon.ts` for hook discovery, or `undefined` when there is none — or when
 * it fails to load. Deliberately best-effort: `checkout` on an *existing* branch must keep
 * working even with a broken `neon.ts` sitting in the repo, exactly as it did before hooks
 * existed. A load failure other than "missing" degrades to a warning rather than aborting
 * the checkout; a genuinely broken policy still surfaces loudly the moment something that
 * actually depends on it runs — `checkout --create`'s own `createBranchFromPolicyOnCheckout`,
 * or `deploy`, both load the config again through their own (throwing) path. Callers read
 * `.experimental?.hooks` off the result for the hooks block, and pass the whole thing to
 * {@link resolveHookEnv} so `after` hooks resolve exactly the namespaces the policy declares.
 */
export const loadHookConfig = async (
	cwd: string,
): Promise<Config | undefined> => {
	try {
		const { config } = await loadConfigFromFile({ cwd });
		return config;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!/Could not find a Neon config file/i.test(message)) {
			log.warning(
				"Could not load neon.ts for lifecycle hooks (continuing without them): %s",
				message,
			);
		}
		return undefined;
	}
};

/** Stream hook (shell) output through the CLI logger. */
const onOutput = (chunk: string) => {
	const text = chunk.replace(/\n$/, "");
	if (text.length > 0) log.info("%s", text);
};

/**
 * Run the `checkout.before` hook (if any). Returns the rewritten branch name when the hook
 * (function form) returns `{ name }`, else `undefined`. Throws propagate to abort the
 * checkout — that's the documented `before`-hook contract.
 */
export const runCheckoutBeforeHook = async (args: {
	hooks: Hooks | undefined;
	event: CheckoutEvent;
	git: GitContext;
	cwd: string;
}): Promise<string | undefined> => {
	const hook = args.hooks?.checkout?.before;
	if (!hook) return undefined;
	const result = await runHook(
		hook,
		{ event: args.event, git: args.git },
		{ cwd: args.cwd, onOutput },
	);
	return result?.name;
};

/**
 * Run the `create.before` hook (if any). Fires only when a new branch is actually about to
 * be created (never for `checkout` selecting an existing one). Throws propagate to abort
 * the create — the checkout that triggered it aborts too.
 */
export const runCreateBeforeHook = async (args: {
	hooks: Hooks | undefined;
	branchName: string;
	git: GitContext;
	event: CheckoutEvent;
	cwd: string;
}): Promise<void> => {
	const hook = args.hooks?.create?.before;
	if (!hook) return;
	await runHook(
		hook,
		{ branchName: args.branchName, git: args.git, event: args.event },
		{ cwd: args.cwd, onOutput },
	);
};

/** Run the `deploy.before` hook (if any). Throws propagate to abort the deploy. */
export const runDeployBeforeHook = async (args: {
	hooks: Hooks | undefined;
	branch: HookBranch;
	git: GitContext;
	event: DeployEvent;
	cwd: string;
}): Promise<void> => {
	const hook = args.hooks?.deploy?.before;
	if (!hook) return;
	await runHook(
		hook,
		{ branch: args.branch, git: args.git, event: args.event },
		{ cwd: args.cwd, onOutput },
	);
};

/**
 * Run the `checkout.after` hook (if any). Failures degrade to a warning — the branch is
 * already checked out, so an `after` failure must not unwind the pin.
 */
export const runCheckoutAfterHook = async (args: {
	hooks: Hooks | undefined;
	branch: HookBranch;
	env: HookEnv;
	git: GitContext;
	event: CheckoutEvent;
	cwd: string;
}): Promise<void> => {
	const hook = args.hooks?.checkout?.after;
	if (!hook) return;
	await runAfter("checkout.after", () =>
		runHook(
			hook,
			{
				branch: args.branch,
				env: args.env,
				git: args.git,
				event: args.event,
			},
			{ cwd: args.cwd, env: hookEnvToProcessEnv(args.env), onOutput },
		),
	);
};

/**
 * Run the `create.after` hook (if any). Failures degrade to a warning — the branch already
 * exists, so an `after` failure must not unwind the create.
 */
export const runCreateAfterHook = async (args: {
	hooks: Hooks | undefined;
	branch: HookBranch;
	env: HookEnv;
	git: GitContext;
	event: CheckoutEvent;
	cwd: string;
}): Promise<void> => {
	const hook = args.hooks?.create?.after;
	if (!hook) return;
	await runAfter("create.after", () =>
		runHook(
			hook,
			{
				branch: args.branch,
				env: args.env,
				git: args.git,
				event: args.event,
			},
			{ cwd: args.cwd, env: hookEnvToProcessEnv(args.env), onOutput },
		),
	);
};

/** Run the `deploy.after` hook (if any). Failures degrade to a warning (apply already ran). */
export const runDeployAfterHook = async (args: {
	hooks: Hooks | undefined;
	branch: HookBranch;
	env: HookEnv;
	result: PushResult;
	git: GitContext;
	event: DeployEvent;
	cwd: string;
}): Promise<void> => {
	const hook = args.hooks?.deploy?.after;
	if (!hook) return;
	await runAfter("deploy.after", () =>
		runHook(
			hook,
			{
				branch: args.branch,
				env: args.env,
				result: args.result,
				git: args.git,
				event: args.event,
			},
			{ cwd: args.cwd, env: hookEnvToProcessEnv(args.env), onOutput },
		),
	);
};

const runAfter = async (
	label: string,
	run: () => Promise<unknown>,
): Promise<void> => {
	try {
		await run();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.warning(
			"The `%s` hook failed: %s\nThe branch change already succeeded; re-run the hook " +
				"manually if needed.",
			label,
			message,
		);
	}
};

/**
 * Fetch the branch's resolved Neon env (DATABASE_URL, …) for an `after` hook, shaped into
 * {@link HookEnv}. Resolved in-memory regardless of `--env-pull`, so a migration hook always
 * has a connection string even when no `.env` is written. Returns `undefined` on failure so
 * the caller can skip the hook with a warning rather than crash.
 *
 * `config` is the same policy the checkout/deploy is already working from — it decides
 * which namespaces `fetchEnvKeys` resolves (an empty/default `Config` would resolve
 * postgres only, since nothing else is declared enabled).
 */
export const resolveHookEnv = async (
	config: Config,
	options: FetchEnvKeysOptions,
): Promise<HookEnv | undefined> => {
	try {
		const resolved = await fetchEnvKeys(config, options, null);
		return shapeHookEnv(resolved);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.warning("Could not resolve env for the after hook: %s", message);
		return undefined;
	}
};

/**
 * Map `@neon-internals/env-core`'s flat, all-optional {@link ResolvedNeonEnv} into
 * {@link HookEnv}. Pure — split out from {@link resolveHookEnv} so the shaping is testable
 * without a live Neon API call. `postgres` always defaults to empty strings rather than
 * being dropped: {@link HookEnv.postgres} is the one namespace every hook can rely on
 * existing, even when this particular fetch didn't select either connection string.
 */
export const shapeHookEnv = (resolved: ResolvedNeonEnv): HookEnv => ({
	postgres: {
		databaseUrl: resolved.postgres?.databaseUrl ?? "",
		databaseUrlUnpooled: resolved.postgres?.databaseUrlUnpooled ?? "",
	},
	...(resolved.branch?.name
		? { branch: { name: resolved.branch.name } }
		: {}),
	...(resolved.auth?.baseUrl !== undefined &&
	resolved.auth.jwksUrl !== undefined
		? {
				auth: {
					baseUrl: resolved.auth.baseUrl,
					jwksUrl: resolved.auth.jwksUrl,
				},
			}
		: {}),
	...(resolved.dataApi?.url !== undefined
		? { dataApi: { url: resolved.dataApi.url } }
		: {}),
	...(resolved.storage?.accessKeyId !== undefined &&
	resolved.storage.secretAccessKey !== undefined &&
	resolved.storage.endpoint !== undefined &&
	resolved.storage.region !== undefined
		? {
				storage: {
					accessKeyId: resolved.storage.accessKeyId,
					secretAccessKey: resolved.storage.secretAccessKey,
					endpoint: resolved.storage.endpoint,
					region: resolved.storage.region,
				},
			}
		: {}),
	...(resolved.aiGateway?.apiKey !== undefined &&
	resolved.aiGateway.baseUrl !== undefined
		? {
				aiGateway: {
					apiKey: resolved.aiGateway.apiKey,
					baseUrl: resolved.aiGateway.baseUrl,
				},
			}
		: {}),
	...(resolved.functions
		? {
				functions: Object.fromEntries(
					Object.entries(resolved.functions).map(([slug, fn]) => [
						slug,
						{ baseUrl: fn.baseUrl },
					]),
				),
			}
		: {}),
});

/** Re-derive the OS-level env vars from a {@link HookEnv} for shell-hook injection. */
const hookEnvToProcessEnv = (env: HookEnv): Record<string, string> => {
	const out: Record<string, string> = {
		DATABASE_URL: env.postgres.databaseUrl,
		DATABASE_URL_UNPOOLED: env.postgres.databaseUrlUnpooled,
	};
	if (env.branch?.name) out.NEON_BRANCH = env.branch.name;
	if (env.auth) {
		out.NEON_AUTH_BASE_URL = env.auth.baseUrl;
		out.NEON_AUTH_JWKS_URL = env.auth.jwksUrl;
	}
	if (env.dataApi) out.NEON_DATA_API_URL = env.dataApi.url;
	if (env.storage) {
		out.AWS_ACCESS_KEY_ID = env.storage.accessKeyId;
		out.AWS_SECRET_ACCESS_KEY = env.storage.secretAccessKey;
		out.AWS_ENDPOINT_URL_S3 = env.storage.endpoint;
		out.AWS_REGION = env.storage.region;
	}
	if (env.aiGateway) {
		out.NEON_AI_GATEWAY_TOKEN = env.aiGateway.apiKey;
		out.NEON_AI_GATEWAY_BASE_URL = env.aiGateway.baseUrl;
	}
	return out;
};

/**
 * Build a {@link HookBranch} from the live branch metadata. `created` is supplied by the
 * caller (only the checkout/deploy flow knows whether this op created the branch).
 */
export const buildHookBranch = async (args: {
	apiClient: NeonApiClient;
	projectId: string;
	branchId: string;
	created: boolean;
}): Promise<HookBranch> => {
	const { data } = await args.apiClient.getProjectBranch(
		args.projectId,
		args.branchId,
	);
	const branch = data.branch;
	return {
		projectId: args.projectId,
		id: branch.id,
		name: branch.name,
		created: args.created,
		isDefault: branch.default ?? false,
		isProtected: branch.protected ?? false,
		...(branch.parent_id ? { parentId: branch.parent_id } : {}),
		...(branch.expires_at ? { expiresAt: branch.expires_at } : {}),
	};
};
