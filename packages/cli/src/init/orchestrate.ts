import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { supportsSkills, tryResolveAddMcpAgentId } from "./agents.js";
import { isAuthenticated } from "./auth.js";
import { inspectProject } from "./inspect.js";
import { handleAuthPhase } from "./phases/auth.js";
import { handleGettingStartedPhase } from "./phases/getting_started.js";
import { handleMigrationsPhase } from "./phases/migrations.js";
import { handleNeonAuthPhase } from "./phases/neon_auth.js";
import { handleSetupPhase } from "./phases/setup.js";
import { resolveNeonContext } from "./resolve_context.js";
import { skillsInstalledForAgent } from "./skills.js";
import type { PhaseResponse } from "./types.js";

export type OrchestratorOptions = {
	agent?: string;
	skipMigrations?: boolean;
	/** Enable preview features (e.g. project bootstrapping from templates) */
	preview?: boolean;
};

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
 * - No app detected → bootstrap phase (scaffold from template)
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
		{ id: "has_app", description: "", lookFor: [] },
		{ id: "mcp_server", description: "", lookFor: [] },
		{ id: "skills", description: "", lookFor: [] },
		{ id: "connection_string", description: "", lookFor: [] },
		{ id: "project_stack", description: "", lookFor: [] },
		{ id: "migrations", description: "", lookFor: [] },
	]);

	// Only detect empty projects when --preview is enabled
	const hasApp = options.preview ? inspection.hasApp === true : true;

	// When preview is enabled, check that all preview skills are installed too
	let skillsInstalled = inspection.skillsInstalled;
	if (options.preview && skillsInstalled && inspection.skillsScope) {
		const { getSkillList } = await import("./skills.js");
		const previewSkills = getSkillList(true);
		const { existsSync: exists } = await import("node:fs");
		const { resolve: resolvePath } = await import("node:path");
		const home = process.env.HOME || process.env.USERPROFILE || "";
		const scope = inspection.skillsScope;
		const dirs =
			scope === "project"
				? [
						resolvePath(cwd, ".cursor", "skills"),
						resolvePath(cwd, ".claude", "skills"),
						resolvePath(cwd, ".agents", "skills"),
					]
				: [
						resolvePath(home, ".cursor", "skills"),
						resolvePath(home, ".claude", "skills"),
						resolvePath(home, ".agents", "skills"),
					];
		const allPresent = previewSkills.every((skill) =>
			dirs.some((dir) => exists(resolvePath(dir, skill, "SKILL.md"))),
		);
		if (!allPresent) {
			skillsInstalled = false;
			// Mark as partial so setup auto-completes to the same scope
			inspection.skillsScope =
				`${inspection.skillsScope}-partial` as typeof inspection.skillsScope;
		}
	}

	const requestedAgent = options.agent
		? tryResolveAddMcpAgentId(options.agent)
		: undefined;
	const mcpForThisAgent = requestedAgent
		? (inspection.mcpAgents ?? []).some(
				(hit) => hit.agent === requestedAgent,
			)
		: inspection.mcpConfigured === true;
	const skillsReady =
		requestedAgent && !supportsSkills(requestedAgent)
			? true
			: requestedAgent
				? skillsInstalledForAgent(requestedAgent, cwd)
				: skillsInstalled === true;
	const toolingInstalled = mcpForThisAgent && skillsReady;
	const hasNeonConnection = inspection.connectionString === true;

	// Phase 3a: No app or tooling not installed → setup flow
	// When !hasApp (preview mode), setup will offer template selection before asking about tooling.
	// Clean up any stale _init state from a previous run.
	if (!hasApp || !toolingInstalled) {
		cleanupInitState(resolve(cwd, ".neon"));
		return handleSetupPhase({
			agent: options.agent,
			preview: options.preview,
			hasApp,
			mcpConfigured: requestedAgent
				? mcpForThisAgent
				: (inspection.mcpConfigured ?? null),
			mcpScope: inspection.mcpScope || undefined,
			skillsInstalled: skillsInstalled ?? null,
			skillsScope: inspection.skillsScope || undefined,
		});
	}

	// Read .neon context early — needed for feature-based routing
	const neonContextPath = resolve(cwd, ".neon");
	const neonContext = readNeonContext(neonContextPath);
	const initState =
		typeof neonContext._init === "object" && neonContext._init !== null
			? (neonContext._init as Record<string, unknown>)
			: {};
	const features: string[] = Array.isArray(initState.features)
		? initState.features
		: [];

	// Phase 3b: Tooling installed but no Neon connection string → getting-started
	if (!hasNeonConnection) {
		return handleGettingStartedPhase({
			agent: options.agent,
			cwd,
			hasConnectionString: false,
			framework: inspection.framework as string | undefined,
			orm: inspection.orm as string | undefined,
			migrationTool: inspection.migrationTool as string | undefined,
			migrationDir: inspection.migrationDir as string | undefined,
			features,
			preview: options.preview,
		});
	}

	// Phase 3c: Neon connection exists but no .neon context file → resolve project

	if (!neonContext.projectId) {
		// Resolve the project from the connection string and merge into .neon
		try {
			const resolved = await resolveNeonContext(cwd);
			if (resolved) {
				const merged = { ...neonContext };
				if (resolved.orgId) merged.orgId = resolved.orgId;
				if (resolved.projectId) merged.projectId = resolved.projectId;
				writeFileSync(
					neonContextPath,
					`${JSON.stringify(merged, null, 2)}\n`,
				);
			}
		} catch {
			// Continue the flow regardless — missing .neon is not a blocker
		}
	}

	// Phase 4: Neon Auth — only if features include "auth"
	if (features.includes("auth")) {
		const hasNeonAuth = checkNeonAuth(cwd);
		if (!hasNeonAuth) {
			return handleNeonAuthPhase({
				agent: options.agent,
				setup: true,
			});
		}
	}

	// Phase 5: Migrations
	if (!options.skipMigrations) {
		return handleMigrationsPhase({ agent: options.agent, cwd });
	}

	// All done — clean up ephemeral _init state from .neon
	cleanupInitState(neonContextPath);

	return {
		phase: "setup",
		status: "complete",
		nextAction: {
			type: "complete",
			message:
				requestedAgent && !supportsSkills(requestedAgent)
					? "Neon setup is complete. Your database is configured and your agent has the Neon MCP server available."
					: "Neon setup is complete. Your database is configured and your agent has the Neon MCP server and skills available.",
		},
	};
}

/** Remove the ephemeral _init key from .neon, preserving other fields. */
function cleanupInitState(neonContextPath: string): void {
	if (!existsSync(neonContextPath)) return;
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

function readNeonContext(neonContextPath: string): Record<string, unknown> {
	if (!existsSync(neonContextPath)) return {};
	try {
		return JSON.parse(readFileSync(neonContextPath, "utf-8"));
	} catch {
		return {};
	}
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
