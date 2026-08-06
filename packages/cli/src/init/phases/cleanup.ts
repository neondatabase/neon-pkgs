import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PhaseResponse } from "../types.js";

/**
 * Terminal phase: cleans up ephemeral _init state from .neon and
 * returns a complete message. All feature chains should end here.
 */
export function handleCleanup(): PhaseResponse {
	const neonContextPath = resolve(process.cwd(), ".neon");
	if (existsSync(neonContextPath)) {
		try {
			const context = JSON.parse(readFileSync(neonContextPath, "utf-8"));
			if (context._init !== undefined) {
				delete context._init;
				writeFileSync(
					neonContextPath,
					`${JSON.stringify(context, null, 2)}\n`,
				);
			}
		} catch {}
	}

	return {
		phase: "setup",
		status: "complete",
		nextAction: {
			type: "complete",
			message:
				"Neon setup is complete! Your database is connected and your agent has the Neon MCP server and skills available.",
		},
	};
}
