import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isAuthenticated } from "./lib/auth.js";
import { inspectProject } from "./lib/inspect.js";
import { handleAuthPhase } from "./lib/phases/auth.js";
import { handleGettingStartedPhase } from "./lib/phases/getting-started.js";
import { handleMigrationsPhase } from "./lib/phases/migrations.js";
import { handleNeonAuthPhase } from "./lib/phases/neon-auth.js";
import { handleSetupPhase } from "./lib/phases/setup.js";
import { resolveNeonContext } from "./lib/resolve-context.js";
import type { PhaseResponse } from "./lib/types.js";

export interface OrchestratorOptions {
	agent?: string;
	skipNeonAuth?: boolean;
	skipMigrations?: boolean;
}

/**
 * v2 orchestrator: checks phases in order and returns the first that needs attention.
 *
 * Phase order:
 *   auth -> setup (if tooling not installed)
 *        -> getting-started (if tooling installed but no Neon connection string)
 *        -> resolve .neon context (if connection string exists but no .neon file)
 *        -> neon_auth (optional) -> complete
 *
 * Each call is stateless — it re-checks everything from the file system and credentials.
 *
 * The orchestrator uses filesystem inspection to decide what to do:
 * - MCP not configured → full setup flow (inspect → install → getting-started)
 * - MCP configured, no connection string → skip install, go to getting-started
 * - MCP configured + connection string → fall through to neon-auth/migrations/complete
 */
export async function orchestrate(
	options: OrchestratorOptions,
): Promise<PhaseResponse> {
	// Phase 1: Auth
	const authed = await isAuthenticated();
	if (!authed) {
		return handleAuthPhase({ agent: options.agent });
	}

	const cwd = process.cwd();

	// Phase 2: Inspect what's already in place
	const inspection = await inspectProject([
		{ id: "mcp_server", description: "", lookFor: [] },
		{ id: "skills", description: "", lookFor: [] },
		{ id: "connection_string", description: "", lookFor: [] },
		{ id: "project_stack", description: "", lookFor: [] },
		{ id: "migrations", description: "", lookFor: [] },
	]);

	const toolingInstalled =
		inspection.mcpConfigured && inspection.skillsInstalled;
	const hasNeonConnection = inspection.connectionString === true;

	// Phase 3a: Tooling not installed → full setup flow
	// Don't pre-fill inspection results — the setup phase asks the agent to
	// check and report back.
	if (!toolingInstalled) {
		return handleSetupPhase({ agent: options.agent });
	}

	// Phase 3b: Tooling installed but no Neon connection string → getting-started
	if (!hasNeonConnection) {
		return handleGettingStartedPhase({
			agent: options.agent,
			hasConnectionString: false,
			framework: inspection.framework as string | undefined,
			orm: inspection.orm as string | undefined,
			migrationTool: inspection.migrationTool as string | undefined,
			migrationDir: inspection.migrationDir as string | undefined,
		});
	}

	// Phase 3c: Neon connection exists but no .neon context file → resolve project
	const neonContextPath = resolve(cwd, ".neon");
	const hasNeonContext =
		existsSync(neonContextPath) &&
		(() => {
			try {
				const content = JSON.parse(
					readFileSync(neonContextPath, "utf-8"),
				);
				return !!content.projectId;
			} catch {
				return false;
			}
		})();

	if (!hasNeonContext) {
		// Resolve the project from the connection string and write .neon
		try {
			const resolved = await resolveNeonContext(cwd);
			if (resolved) {
				const contextData: Record<string, string> = {};
				if (resolved.orgId) contextData.orgId = resolved.orgId;
				if (resolved.projectId)
					contextData.projectId = resolved.projectId;
				writeFileSync(
					neonContextPath,
					`${JSON.stringify(contextData, null, 2)}\n`,
				);
			}
		} catch {
			// Continue the flow regardless — missing .neon is not a blocker
		}
	}

	// Phase 4: Neon Auth (optional)
	if (!options.skipNeonAuth) {
		const hasNeonAuth = checkNeonAuth(cwd);
		if (!hasNeonAuth) {
			return handleNeonAuthPhase({ agent: options.agent });
		}
	}

	// Phase 5: Migrations
	if (!options.skipMigrations) {
		return handleMigrationsPhase({ agent: options.agent });
	}

	// All done
	return {
		phase: "setup",
		status: "complete",
		nextAction: {
			type: "complete",
			message:
				"Neon setup is complete. Your database is configured and your agent has the Neon MCP server and skills available.",
		},
	};
}

function checkNeonAuth(cwd: string): boolean {
	const envPath = resolve(cwd, ".env");
	if (!existsSync(envPath)) return false;
	try {
		const content = readFileSync(envPath, "utf-8");
		return /^NEON_AUTH_/m.test(content);
	} catch {
		return false;
	}
}
