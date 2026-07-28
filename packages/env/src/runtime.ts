/**
 * `@neon/env/runtime` — stateful helpers for the tools that resolve a branch's env
 * repeatedly, kept out of the main entry point on purpose.
 *
 * The root export (`@neon/env`) is the pure half: `fetchEnv` asks the Neon API for a branch's
 * env and returns it, `parseEnv` reads what was injected, neither knows anything about files
 * or previous runs. That is the whole surface an application or build script needs.
 *
 * This entry point is for the other kind of caller — a CLI or dev server that resolves the
 * same branch over and over and therefore has to care that a credential's secrets are issued
 * exactly once. It reads an env source, decides what is still valid, and revokes what it
 * supersedes. Mirrors the split between `@neon/config` and `@neon/config-runtime`: import it
 * from a CLI or CI, never from a `neon.ts` policy or an app bootstrap.
 */

export type {
	CredentialOutcome,
	ReusedBranchEnv,
} from "./lib/reuse-secrets.js";
export { fetchEnvReusingSecrets } from "./lib/reuse-secrets.js";
