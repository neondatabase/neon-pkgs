import { isAuthenticated } from "../auth.js";
import { inspectProject } from "../inspect.js";
import type { StatusResponse } from "../types.js";

export interface StatusOptions {
	agent?: string;
}

export async function handleStatusPhase(
	options: StatusOptions,
): Promise<StatusResponse> {
	const authed = await isAuthenticated();

	const inspection = await inspectProject([
		{ id: "database_url", description: "", lookFor: [] },
		{ id: "skills", description: "", lookFor: [] },
		{ id: "migrations", description: "", lookFor: [] },
	]);

	const hasDatabaseUrl = inspection.databaseUrl === true;
	const skillsInstalled = inspection.skillsInstalled === true;
	const migrationTool = (inspection.migrationTool as string | null) ?? null;
	const hasMigrations =
		migrationTool !== null &&
		migrationTool !== "none" &&
		inspection.migrationDir !== "none";

	const recommendations: StatusResponse["recommendations"] = [];

	if (!authed) {
		recommendations.push({
			priority: "high",
			message: "Not authenticated with Neon",
			command: "neonctl init auth --agent --json",
		});
	}

	if (!hasDatabaseUrl) {
		recommendations.push({
			priority: "high",
			message: "No DATABASE_URL found in .env",
			command: "neonctl init db --agent --json",
		});
	}

	if (!skillsInstalled) {
		recommendations.push({
			priority: "medium",
			message: "Neon agent skills not detected in this project",
			command: options.agent
				? `neonctl init skills --json --agent ${options.agent} --install`
				: "neonctl init skills --json --install",
		});
	}

	if (migrationTool && !hasMigrations) {
		recommendations.push({
			priority: "medium",
			message: `${migrationTool} detected but no migrations found`,
			command: "neonctl init migrations --agent --json",
		});
	}

	return {
		auth: {
			authenticated: authed,
		},
		tooling: {
			mcpServer: { configured: null },
			skills: { installed: skillsInstalled },
		},
		project: {
			databaseUrl: hasDatabaseUrl,
		},
		migrations: {
			tool: migrationTool,
			hasMigrations,
		},
		recommendations,
	};
}
