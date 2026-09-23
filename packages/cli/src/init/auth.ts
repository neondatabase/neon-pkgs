import { isNeonApiError } from "../api.js";
import { defaultClientID } from "../auth.js";
import { recoverFrom401 } from "../auth_recovery.js";
import { ensureAuth } from "../commands/auth.js";
import { type EnvPullProps, type PullOutcome, pull } from "../commands/env.js";
import {
	type McpInstallOutcome,
	type SetupNeonMcpOptions,
	setupNeonMcp,
} from "../commands/mcp.js";
import { defaultDir } from "../config.js";
import type { CommonProps } from "../types.js";

/**
 * `neon init` / `neon bootstrap` skip global auth (`commands/auth.ts:ensureAuth` returns
 * early for `_[0] === "init"`) and delegate authentication to whichever step actually needs
 * it — the same way each of those steps authenticates when run as a standalone command.
 * This is the field set `ensureAuth` needs to resolve credentials for one of those steps,
 * already threaded through `InitProps`/`InitLinkProps`.
 */
export type InitAuthOptions = Pick<
	CommonProps,
	"apiClient" | "apiKey" | "apiHost" | "contextFile"
> & {
	configDir?: string;
	profile?: string;
	oauthHost?: string;
	clientId?: string;
	forceAuth?: boolean;
	allowUnsafeTls?: boolean;
};

const isUnauthorized = (error: unknown): boolean =>
	isNeonApiError(error) && error.status === 401;

const authenticationFailed = (): Error => new Error("Authentication failed.");

/**
 * Fills in the fields `ensureAuth` requires beyond `InitAuthOptions`, and sets `_` so
 * `ensureAuth`'s per-command branches (`isMcpCommand`, `isSkillsCommand`, ...) treat this
 * exactly like the standalone command it names — mirrors `init/link.ts`'s `runAuthenticatedLink`.
 */
const authContext = <T extends InitAuthOptions>(
	options: T,
	command: readonly string[],
) => ({
	...options,
	_: [...command],
	configDir: options.configDir ?? defaultDir,
	oauthHost:
		options.oauthHost ??
		process.env.NEON_OAUTH_HOST ??
		"https://oauth2.neon.tech",
	clientId: options.clientId ?? defaultClientID,
	help: false,
});

/**
 * Resolves Neon auth the same way a standalone `neon mcp` invocation would, then runs
 * `setupNeonMcp`. `init`/`bootstrap` never resolve a shared `apiClient` of their own for
 * this (see `InitAuthOptions` above), so this is what does it, per call.
 *
 * Skips `ensureAuth` entirely when `options.oauth` is true: `setupNeonMcp`'s oauth branch
 * never reads `apiClient`/`apiKey`, and `ensureAuth`'s own `isMcpOauth` skip reads the real
 * `process.argv` for `--oauth` (documented there as required because that middleware runs
 * before flag parsing) — which never contains it for a `neon init`/`bootstrap` process, so
 * `ensureAuth` would otherwise try to resolve credentials it doesn't need and can fail on
 * an unrelated bad profile or expired session.
 */
export const runAuthenticatedMcp = async (
	options: SetupNeonMcpOptions & InitAuthOptions,
): Promise<McpInstallOutcome> => {
	if (options.oauth === true) {
		return setupNeonMcp(options);
	}
	const authenticated = authContext(options, ["mcp"]);
	await ensureAuth(authenticated);
	try {
		return await setupNeonMcp(authenticated);
	} catch (error) {
		if (!isUnauthorized(error)) {
			throw error;
		}
		if (!(await recoverFrom401(true))) {
			throw authenticationFailed();
		}
	}
	await ensureAuth(authenticated);
	try {
		return await setupNeonMcp(authenticated);
	} catch (error) {
		if (!isUnauthorized(error)) {
			throw error;
		}
		await recoverFrom401(false);
		throw authenticationFailed();
	}
};

/**
 * Resolves Neon auth the same way a standalone `neon env pull` invocation would, then runs
 * `pull` — the same function `link`/`checkout` already call directly via
 * `autoPullEnvAfterPin` (see `commands/env.ts`).
 */
export const pullInitEnv = async (
	props: EnvPullProps & InitAuthOptions,
): Promise<PullOutcome> => {
	const authenticated = authContext(props, ["env", "pull"]);
	await ensureAuth(authenticated);
	const opts = { announce: true, implyAiGateway: true };
	try {
		return await pull(authenticated, opts);
	} catch (error) {
		if (!isUnauthorized(error)) {
			throw error;
		}
		if (!(await recoverFrom401(true))) {
			throw authenticationFailed();
		}
	}
	await ensureAuth(authenticated);
	try {
		return await pull(authenticated, opts);
	} catch (error) {
		if (!isUnauthorized(error)) {
			throw error;
		}
		await recoverFrom401(false);
		throw authenticationFailed();
	}
};
