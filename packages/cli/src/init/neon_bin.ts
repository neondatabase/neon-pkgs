import which from "which";

/**
 * How to invoke the `neon` CLI in the commands the init flow hands to agents and
 * users: the installed binary when one is on PATH, otherwise `npx -y neon`.
 *
 * `neon init` installs the Neon CLI (see `ensureNeonctl`), so once that has run
 * the bare binary is used — no per-command npx resolution cost. A first run
 * started with `npx neon init`, before the CLI is installed, has no `neon` on
 * PATH yet, so the emitted commands fall back to npx and still work. Detection
 * happens per call (at response-build time) so the prefix reflects the machine's
 * current state.
 */
export function neonBin(): string {
	return which.sync("neon", { nothrow: true }) ? "neon" : "npx -y neon";
}
