/**
 * Routes neon-init CLI args to the appropriate phase handler directly,
 * without shelling out. This is the in-process equivalent of calling
 * `neon-init <subcommand> <flags>`.
 */

import { detectAgent } from "./detect-agent.js";
import type { PhaseResponse } from "./types.js";

function resolveAgent(explicit: string | undefined): string | undefined {
	return explicit ?? detectAgent() ?? undefined;
}

/** Known short flag aliases (mirrors yargs config in cli.ts) */
const SHORT_FLAG_MAP: Record<string, string> = {
	a: "agent",
};

function parseArgs(args: string[]): Record<string, string | boolean> {
	const result: Record<string, string | boolean> = {};
	let i = 0;

	// First arg may be the subcommand
	if (args.length > 0 && !args[0].startsWith("-")) {
		result._command = args[0];
		i = 1;
	}

	while (i < args.length) {
		const arg = args[i];
		if (arg.startsWith("--")) {
			const key = arg
				.slice(2)
				.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
			const nextArg = args[i + 1];
			if (nextArg !== undefined && !nextArg.startsWith("-")) {
				result[key] = nextArg;
				i += 2;
			} else {
				result[key] = true;
				i += 1;
			}
		} else if (
			arg.startsWith("-") &&
			!arg.startsWith("--") &&
			arg.length === 2
		) {
			const shortKey = arg[1];
			const longKey = SHORT_FLAG_MAP[shortKey] ?? shortKey;
			const nextArg = args[i + 1];
			if (nextArg !== undefined && !nextArg.startsWith("-")) {
				result[longKey] = nextArg;
				i += 2;
			} else {
				result[longKey] = true;
				i += 1;
			}
		} else {
			i += 1;
		}
	}

	return result;
}

function toBool(val: string | boolean | undefined): boolean | null {
	if (val === true || val === "true") return true;
	if (val === false || val === "false") return false;
	return null;
}

export async function routeCommand(args: string[]): Promise<PhaseResponse> {
	const parsed = parseArgs(args);
	const command = parsed._command as string | undefined;
	const agent = resolveAgent(parsed.agent as string | undefined);

	switch (command) {
		case "finalize": {
			const { handleCleanup } = await import("./phases/cleanup.js");
			return handleCleanup();
		}

		case "auth": {
			const { handleAuthPhase } = await import("./phases/auth.js");
			return handleAuthPhase({
				agent,
				method: parsed.method as "existing" | "new" | undefined,
				verify: parsed.verify === true,
			});
		}

		case "mcp": {
			const { handleMcpPhase } = await import("./phases/mcp.js");
			return handleMcpPhase({
				agent,
				status: parsed.status === true,
				install: parsed.install === true || parsed.update === true,
				scope: (parsed.scope as "global" | "project") ?? "global",
				mcpConfigured: toBool(parsed.mcpConfigured),
			});
		}

		case "skills": {
			const { handleSkillsPhase } = await import("./phases/skills.js");
			return handleSkillsPhase({
				agent,
				status: parsed.status === true,
				install: parsed.install === true,
				update: parsed.update === true,
			});
		}

		case "setup": {
			const { handleSetupPhase } = await import("./phases/setup.js");

			// --data JSON path
			if (typeof parsed.data === "string") {
				let data: Record<string, unknown>;
				try {
					data = JSON.parse(parsed.data);
				} catch {
					throw new Error("Invalid JSON in --data flag");
				}

				// Normalize string booleans
				for (const key of [
					"mcpConfigured",
					"connectionString",
					"isVscodeIde",
					"installExtension",
					"execute",
				]) {
					if (data[key] === "true") data[key] = true;
					else if (data[key] === "false") data[key] = false;
				}

				return handleSetupPhase({
					agent,
					...data,
				} as Parameters<typeof handleSetupPhase>[0]);
			}

			return handleSetupPhase({
				agent,
				mcpConfigured: toBool(parsed.mcpConfigured),
				connectionString: toBool(parsed.connectionString),
				framework: parsed.framework as string | undefined,
				orm: parsed.orm as string | undefined,
				migrationTool: parsed.migrationTool as string | undefined,
				migrationDir: parsed.migrationDir as string | undefined,
				isVscodeIde: toBool(parsed.isVscodeIde),
				mode: parsed.mode as "defaults" | "customize" | undefined,
				mcpScope: parsed.mcpScope as "global" | "project" | undefined,
				skillsScope: parsed.skillsScope as
					| "global"
					| "project"
					| undefined,
				installExtension: toBool(parsed.installExtension) === true,
				execute: parsed.execute === true,
			});
		}

		case "getting-started": {
			const { handleGettingStartedPhase } = await import(
				"./phases/getting-started.js"
			);

			if (typeof parsed.data === "string") {
				let data: Record<string, unknown>;
				try {
					data = JSON.parse(parsed.data);
				} catch {
					throw new Error("Invalid JSON in --data flag");
				}
				return handleGettingStartedPhase({
					agent,
					...data,
				} as Parameters<typeof handleGettingStartedPhase>[0]);
			}

			return handleGettingStartedPhase({
				agent,
				hasConnectionString: parsed.hasConnectionString === true,
				framework: parsed.framework as string | undefined,
				orm: parsed.orm as string | undefined,
				migrationTool: parsed.migrationTool as string | undefined,
				migrationDir: parsed.migrationDir as string | undefined,
			});
		}

		case "db": {
			const { handleDbPhase } = await import("./phases/db.js");
			return handleDbPhase({
				agent,
				orgId: parsed.orgId as string | undefined,
				projectId: parsed.projectId as string | undefined,
				orgsResult: parsed.orgsResult as string | undefined,
				projectsResult: parsed.projectsResult as string | undefined,
				framework: parsed.framework as string | undefined,
				orm: parsed.orm as string | undefined,
				error: parsed.error as string | undefined,
			});
		}

		case "neon-auth": {
			const { handleNeonAuthPhase } = await import(
				"./phases/neon-auth.js"
			);
			return handleNeonAuthPhase({
				agent,
				setup: parsed.setup === true,
				info: parsed.info === true,
				projectId: parsed.projectId as string | undefined,
			});
		}

		case "migrations": {
			const { handleMigrationsPhase } = await import(
				"./phases/migrations.js"
			);
			return handleMigrationsPhase({
				agent,
				tool: parsed.tool as string | undefined,
				migrationDir: parsed.migrationDir as string | undefined,
				scaffold: parsed.scaffold as "prisma" | "drizzle" | undefined,
				apply: parsed.apply === true,
			});
		}

		default: {
			// No subcommand — run the orchestrator
			const { orchestrate } = await import("../v2.js");
			return orchestrate({
				agent,
				skipNeonAuth: parsed.skipNeonAuth === true,
				skipMigrations: parsed.skipMigrations === true,
				preview: parsed.preview === true,
			});
		}
	}
}

/**
 * Routes a --data JSON payload with a "step" field to the appropriate phase
 * handler. This lets agents use a single command surface:
 *   neon-init --agent --data '{"step":"auth"}'
 *   neon-init --agent --data '{"step":"db","projectId":"xyz"}'
 */
export async function routeDataStep(
	data: Record<string, unknown>,
	agent: string | undefined,
): Promise<unknown> {
	const { step, agentId, ...rest } = data;

	// Allow agentId override from data JSON, fall back to caller-provided agent
	const resolvedAgent = typeof agentId === "string" ? agentId : agent;

	// Agents sometimes nest the actual payload inside a "data" key:
	//   {"step":"setup","data":{"mode":"defaults",...}}
	// or as a JSON string:
	//   {"step":"setup","data":"{\"mode\":\"defaults\",...}"}
	// Unwrap it so the phase handler gets the right options.
	if (rest.data !== undefined && Object.keys(rest).length === 1) {
		let nested = rest.data;
		if (typeof nested === "string") {
			try {
				nested = JSON.parse(nested);
			} catch {
				// leave as-is
			}
		}
		if (typeof nested === "object" && nested !== null) {
			Object.assign(rest, nested);
			delete rest.data;
		}
	}

	switch (step) {
		case "auth": {
			const { handleAuthPhase } = await import("./phases/auth.js");
			return handleAuthPhase({
				agent: resolvedAgent,
				...rest,
			} as Parameters<typeof handleAuthPhase>[0]);
		}

		case "db": {
			const { handleDbPhase } = await import("./phases/db.js");
			return handleDbPhase({
				agent: resolvedAgent,
				...rest,
			} as Parameters<typeof handleDbPhase>[0]);
		}

		case "setup": {
			const { handleSetupPhase } = await import("./phases/setup.js");
			return handleSetupPhase({
				agent: resolvedAgent,
				...rest,
			} as Parameters<typeof handleSetupPhase>[0]);
		}

		case "getting-started": {
			const { handleGettingStartedPhase } = await import(
				"./phases/getting-started.js"
			);
			return handleGettingStartedPhase({
				agent: resolvedAgent,
				...rest,
			} as Parameters<typeof handleGettingStartedPhase>[0]);
		}

		case "mcp": {
			const { handleMcpPhase } = await import("./phases/mcp.js");
			return handleMcpPhase({
				agent: resolvedAgent,
				...rest,
			} as Parameters<typeof handleMcpPhase>[0]);
		}

		case "skills": {
			const { handleSkillsPhase } = await import("./phases/skills.js");
			return handleSkillsPhase({
				agent: resolvedAgent,
				...rest,
			} as Parameters<typeof handleSkillsPhase>[0]);
		}

		case "migrations": {
			const { handleMigrationsPhase } = await import(
				"./phases/migrations.js"
			);
			return handleMigrationsPhase({
				agent: resolvedAgent,
				...rest,
			} as Parameters<typeof handleMigrationsPhase>[0]);
		}

		case "neon-auth": {
			const { handleNeonAuthPhase } = await import(
				"./phases/neon-auth.js"
			);
			return handleNeonAuthPhase({
				agent: resolvedAgent,
				...rest,
			} as Parameters<typeof handleNeonAuthPhase>[0]);
		}

		case "status": {
			const { handleStatusPhase } = await import("./phases/status.js");
			return handleStatusPhase({ agent: resolvedAgent });
		}

		case "finalize": {
			const { handleCleanup } = await import("./phases/cleanup.js");
			return handleCleanup();
		}

		default:
			throw new Error(
				`Unknown step: "${step}". Valid steps: auth, db, setup, getting-started, mcp, skills, migrations, neon-auth, status, finalize`,
			);
	}
}
