import { neonctlCmd } from "../neonctl.js";
import { SKILL_REFERENCE_URLS } from "../skills.js";
import type { PhaseResponse } from "../types.js";

/**
 * Validates that an ID contains only safe characters for shell interpolation.
 * Neon org/project IDs are typically UUIDs or slug-like strings.
 */
function assertSafeId(value: string, label: string): void {
	if (!/^[\w.:-]+$/.test(value)) {
		throw new Error(
			`Invalid ${label}: "${value}". Expected alphanumeric, hyphens, underscores, dots, or colons.`,
		);
	}
}

export type DbPhaseOptions = {
	agent?: string;
	orgId?: string;
	projectId?: string;
	orgsResult?: string;
	projectsResult?: string;
	framework?: string;
	orm?: string;
	error?: string;
};

export async function handleDbPhase(
	options: DbPhaseOptions,
): Promise<PhaseResponse> {
	const agentArgs = options.agent
		? ["--agent", options.agent, "--json"]
		: ["--json"];

	// Validate IDs that will be interpolated into shell commands
	if (options.projectId) assertSafeId(options.projectId, "project ID");
	if (options.orgId) assertSafeId(options.orgId, "org ID");

	// Error from a previous step
	if (options.error) {
		return {
			phase: "db",
			status: "error",
			error: options.error,
			nextAction: {
				type: "ask_user",
				question: `An error occurred during database setup: ${options.error}. Would you like to try again or skip this step?`,
				options: [
					{ value: "retry", label: "Try again" },
					{ value: "skip", label: "Skip database setup" },
				],
				responseMapping: {
					retry: { args: ["db", "--json"] },
					skip: { args: agentArgs },
				},
			},
		};
	}

	// If we have a project ID, we're in the "wire it up" phase
	if (options.projectId) {
		return {
			phase: "db",
			status: "project_ready",
			project: { id: options.projectId },
			nextAction: {
				type: "agent_action",
				prerequisite: SKILL_REFERENCE_URLS.connectionMethods,
				steps: [
					{
						id: "get_connection_string",
						description: "Get the database connection string",
						command: `${neonctlCmd()} connection-string --project-id ${options.projectId}`,
					},
					{
						id: "store_env",
						description:
							"Append DATABASE_URL=<connection_string> to .env. Create .env if it doesn't exist. Do NOT overwrite existing entries. Ensure .env is in .gitignore.",
					},
					{
						id: "detect_framework",
						description:
							"Examine the project to determine the framework (Next.js, Remix, Express, etc.) and ORM (Prisma, Drizzle, raw SQL) in use.",
					},
				],
				onComplete: {
					type: "run_neon_init",
					args: agentArgs,
				},
			},
		};
	}

	// If we have projects result, let user pick or create
	if (options.projectsResult) {
		let projects: { id: string; name: string }[];
		try {
			const parsed = JSON.parse(options.projectsResult);
			projects = Array.isArray(parsed.projects)
				? parsed.projects
				: Array.isArray(parsed)
					? parsed
					: [];
		} catch {
			projects = [];
		}

		const orgIdArgs = options.orgId ? ["--org-id", options.orgId] : [];

		if (projects.length === 0) {
			return {
				phase: "db",
				status: "no_projects",
				nextAction: {
					type: "ask_user",
					question:
						"You don't have any Neon projects yet. What would you like to name your new project?",
					options: [
						{
							value: "create",
							label: "Create a new project (provide a name)",
						},
					],
					context:
						`The agent should ask the user for a project name, then run: ${neonctlCmd()} projects create --name <name> --output json` +
						(options.orgId ? ` --org-id ${options.orgId}` : "") +
						" and pass the result back.",
					responseMapping: {
						create: {
							args: [
								"db",
								"--json",
								...orgIdArgs,
								"--project-id",
								"<created-project-id>",
							],
						},
					},
				},
			};
		}

		const projectOptions = projects.map((p) => ({
			value: p.id,
			label: `${p.name} (${p.id})`,
		}));
		projectOptions.push({
			value: "create_new",
			label: "Create a new project",
		});

		const responseMapping: Record<string, { args: string[] }> = {};
		for (const p of projects) {
			responseMapping[p.id] = {
				args: ["db", "--json", ...orgIdArgs, "--project-id", p.id],
			};
		}
		responseMapping.create_new = {
			args: [
				"db",
				"--json",
				...orgIdArgs,
				"--project-id",
				"<created-project-id>",
			],
		};

		return {
			phase: "db",
			status: "select_project",
			nextAction: {
				type: "ask_user",
				question: "Which Neon project would you like to use?",
				options: projectOptions,
				context: `If the user wants to create a new project, ask for a name then run: ${neonctlCmd()} projects create --name <name> --output json and use the returned project id.`,
				responseMapping,
			},
		};
	}

	// If we have orgs result, decide next step
	if (options.orgsResult) {
		let orgs: { id: string; name: string }[];
		try {
			const parsed = JSON.parse(options.orgsResult);
			orgs = Array.isArray(parsed.organizations)
				? parsed.organizations
				: Array.isArray(parsed)
					? parsed
					: [];
		} catch {
			orgs = [];
		}

		// Single org or org already selected: list projects
		const orgId = options.orgId ?? (orgs.length === 1 ? orgs[0].id : null);

		if (orgId) {
			assertSafeId(orgId, "org ID");
			return {
				phase: "db",
				status: "org_selected",
				org: { id: orgId },
				nextAction: {
					type: "run_command",
					command: `${neonctlCmd()} projects list --org-id ${orgId} --output json`,
					description: "Listing Neon projects.",
					timeout: 30000,
					onSuccess: {
						type: "run_neon_init",
						args: [
							"db",
							"--json",
							"--org-id",
							orgId,
							"--projects-result",
							"<stdout>",
						],
					},
					onFailure: {
						other: {
							type: "run_neon_init",
							args: [
								"db",
								"--json",
								"--error",
								"projects-list-failed",
							],
						},
					},
				},
			};
		}

		// Multiple orgs: ask user to pick
		const orgOptions = orgs.map((o) => ({
			value: o.id,
			label: `${o.name} (${o.id})`,
		}));
		const responseMapping: Record<string, { args: string[] }> = {};
		for (const o of orgs) {
			responseMapping[o.id] = {
				args: ["db", "--json", "--org-id", o.id],
			};
		}

		return {
			phase: "db",
			status: "select_org",
			nextAction: {
				type: "ask_user",
				question: "Which Neon organization would you like to use?",
				options: orgOptions,
				responseMapping,
			},
		};
	}

	// If org-id provided but no orgs-result, list projects directly
	if (options.orgId) {
		return {
			phase: "db",
			status: "org_selected",
			org: { id: options.orgId },
			nextAction: {
				type: "run_command",
				command: `${neonctlCmd()} projects list --org-id ${options.orgId} --output json`,
				description: "Listing Neon projects.",
				timeout: 30000,
				onSuccess: {
					type: "run_neon_init",
					args: [
						"db",
						"--json",
						"--org-id",
						options.orgId,
						"--projects-result",
						"<stdout>",
					],
				},
				onFailure: {
					other: {
						type: "run_neon_init",
						args: [
							"db",
							"--json",
							"--error",
							"projects-list-failed",
						],
					},
				},
			},
		};
	}

	// Default: start by listing orgs
	return {
		phase: "db",
		status: "ready",
		nextAction: {
			type: "run_command",
			command: `${neonctlCmd()} orgs list --output json`,
			description: "Listing your Neon organizations.",
			timeout: 30000,
			onSuccess: {
				type: "run_neon_init",
				args: ["db", "--json", "--orgs-result", "<stdout>"],
			},
			onFailure: {
				other: {
					type: "run_neon_init",
					args: ["db", "--json", "--error", "orgs-list-failed"],
				},
			},
		},
	};
}
