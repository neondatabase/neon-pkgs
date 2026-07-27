/**
 * How the current invocation authenticated, recorded by `ensureAuth` so the
 * top-level 401 handler can react to the credential that actually failed.
 *
 * - `api-key`: an explicit `--api-key` flag or `NEON_API_KEY`.
 * - `stored-credentials`: the OAuth token set the CLI keeps in the config dir.
 */
export type AuthSource = "api-key" | "stored-credentials";

export type AuthContext = {
	source: AuthSource;
	configDir: string;
};

let current: AuthContext | null = null;

export const setAuthContext = (context: AuthContext): void => {
	current = context;
};

export const getAuthContext = (): AuthContext | null => current;

/**
 * The config directory whose credentials a 401 should clear, or `null` to leave
 * stored credentials alone.
 *
 * An API key passed on the command line never touches the stored OAuth token,
 * so a 401 on that key says nothing about whether the stored credentials are
 * still good — clearing them would sign the user out of an account the failed
 * request never used. The directory comes from the context rather than the
 * default so that `--config-dir` isolates the deletion too.
 */
export const credentialsToClearOn401 = (
	context: AuthContext | null,
): string | null =>
	context?.source === "stored-credentials" ? context.configDir : null;
