import { neonBin } from "./neon_bin.js";

/**
 * Converts a phase's `args` (e.g. ["setup", "--json", "--data", …]) into the
 * `neon init --agent --data` invocation that reaches the same handler. Uses the
 * installed `neon` binary when present, else `npx -y neon` (see {@link neonBin}),
 * so the chaining commands work even on a first run started with `npx neon init`.
 */
function argsToCommand(args: string[]): string {
	const data: Record<string, unknown> = {};
	let i = 0;

	// First non-flag arg is the subcommand → step
	if (args.length > 0 && !args[0].startsWith("-")) {
		data.step = args[0];
		i = 1;
	}

	while (i < args.length) {
		const arg = args[i];
		if (arg.startsWith("--")) {
			const key = arg
				.slice(2)
				.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
			if (key === "json") {
				i += 1;
				continue;
			}
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				data[key] = next;
				i += 2;
			} else {
				data[key] = true;
				i += 1;
			}
		} else {
			i += 1;
		}
	}

	return `${neonBin()} init --agent --data '${JSON.stringify(data)}'`;
}

/**
 * Walks a phase response object and:
 * 1. Replaces `args` arrays with `command` strings (neon init --data format)
 * 2. Renames `run_neon_init` → `run_shell_command`
 * 3. Adds a description to finalize steps
 */
export function enrichResponse(obj: unknown): unknown {
	if (obj === null || typeof obj !== "object") return obj;
	if (Array.isArray(obj)) return obj.map(enrichResponse);

	const record = obj as Record<string, unknown>;
	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(record)) {
		result[key] = enrichResponse(value);
	}

	// Replace args with command in run_neon_init actions and responseMapping entries
	if (Array.isArray(result.args)) {
		result.command = argsToCommand(result.args as string[]);
		delete result.args;
	}

	// Rename run_neon_init → run_shell_command so agents don't infer subcommand patterns
	if (result.type === "run_neon_init") {
		result.type = "run_shell_command";
	}

	return result;
}
