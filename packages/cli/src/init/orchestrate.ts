import { isAuthenticated } from "./auth.js";
import { handoffResponse } from "./handoff.js";
import { inspectProject } from "./inspect.js";
import { handleAuthPhase } from "./phases/auth.js";
import { handleSetupPhase } from "./phases/setup.js";
import type { PhaseResponse } from "./types.js";

export type OrchestratorOptions = {
	agent?: string;
};

/**
 * v2 orchestrator: checks phases in order and returns the first that needs
 * attention.
 *
 * Phase order:
 *   auth -> setup (if MCP server or skills not installed)
 *        -> hand off to the agent (tooling installed)
 *
 * Each call is stateless — it re-checks credentials and the filesystem every
 * time. `neon init` installs tooling and stops there; connecting a database and
 * configuring features is handed to the agent (see {@link handoffResponse}), so
 * the orchestrator never links projects, pulls env, or touches `.neon`.
 */
export async function orchestrate(
	options: OrchestratorOptions,
): Promise<PhaseResponse> {
	// Phase 1: Auth
	const authed = await isAuthenticated();
	if (!authed) {
		return handleAuthPhase({ agent: options.agent });
	}

	// Phase 2: Is the tooling in place?
	const inspection = await inspectProject([
		{ id: "mcp_server", description: "", lookFor: [] },
		{ id: "skills", description: "", lookFor: [] },
	]);

	const toolingInstalled =
		inspection.mcpConfigured === true &&
		inspection.skillsInstalled === true;

	// Phase 3: Install anything missing.
	if (!toolingInstalled) {
		return handleSetupPhase({
			agent: options.agent,
			mcpConfigured: inspection.mcpConfigured ?? null,
			mcpScope: inspection.mcpScope || undefined,
			skillsInstalled: inspection.skillsInstalled ?? null,
			skillsScope: inspection.skillsScope || undefined,
		});
	}

	// Tooling is ready — hand the rest off to the agent.
	return handoffResponse();
}
