import type { CompleteAction, PhaseResponse } from "./types.js";

/**
 * `neon init` stops once the tooling is in place. Connecting a database and
 * configuring features (Auth, Object Storage, Functions, AI Gateway) is the
 * agent's job from here, driven by the installed Neon skill — the CLI does not
 * link projects, pull env, or provision anything.
 */
export const HANDOFF_MESSAGE =
	"Neon tooling is installed — the MCP server and agent skills are available. " +
	"Ask the user which features they want (Postgres, Auth, Object Storage, Functions, AI Gateway), " +
	"then follow the Neon skill to connect the database and configure the selected features.";

export function handoffAction(): CompleteAction {
	return { type: "complete", message: HANDOFF_MESSAGE };
}

/** The terminal `neon init --agent` response once tooling is installed. */
export function handoffResponse(): PhaseResponse {
	return {
		phase: "setup",
		status: "complete",
		nextAction: handoffAction(),
	};
}
