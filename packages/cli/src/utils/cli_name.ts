import { basename } from "node:path";

/**
 * The name this CLI was invoked as: `neon` (current) or `neonctl` (legacy alias).
 *
 * Use this for any user-facing string that suggests a command to run — help text,
 * error hints, and especially `--agent` `next_command_template` values, which an agent
 * executes verbatim. Hardcoding `neonctl` breaks those on installs of the `neon` package,
 * which no longer ships a `neonctl` binary (removed in `neon@2.38.0`).
 *
 * Derived from `process.argv[1]`, which is fixed for the process lifetime, so the result
 * is stable whether this is called at module load or per invocation. Mirrors the name used
 * for yargs `.scriptName()` in `index.ts`.
 */
export const getCliName = (): string =>
	basename(process.argv[1] ?? "") === "neonctl" ? "neonctl" : "neon";
