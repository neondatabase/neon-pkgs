import { ensureSkillsUpToDate, SKILL_REFERENCE_URLS } from "../skills.js";
import type { PhaseResponse } from "../types.js";

export interface NeonAuthPhaseOptions {
	agent?: string;
	setup?: boolean;
	info?: boolean;
	projectId?: string;
}

export async function handleNeonAuthPhase(
	options: NeonAuthPhaseOptions,
): Promise<PhaseResponse> {
	// Validate IDs that may be interpolated into instruction strings
	if (options.projectId && !/^[\w.:-]+$/.test(options.projectId)) {
		throw new Error(
			`Invalid project ID: "${options.projectId}". Expected alphanumeric, hyphens, underscores, dots, or colons.`,
		);
	}

	// Ensure skills are up to date (no-op if recently updated)
	if (options.agent) {
		await ensureSkillsUpToDate(options.agent);
	}
	// --info: return information about Neon Auth
	if (options.info) {
		return {
			phase: "neon_auth",
			status: "info",
			nextAction: {
				type: "ask_user",
				question:
					"Neon Auth provides drop-in user authentication that integrates with your Neon database. It handles user sign-up, sign-in, and session management. Would you like to set it up?",
				options: [
					{ value: "yes", label: "Yes, set up Neon Auth" },
					{ value: "no", label: "No, skip for now" },
				],
				context: `Full documentation: ${SKILL_REFERENCE_URLS.neonAuth}`,
				responseMapping: {
					yes: {
						args: [
							"neon-auth",
							"--json",
							...(options.agent
								? ["--agent", options.agent]
								: []),
							"--setup",
							...(options.projectId
								? ["--project-id", options.projectId]
								: []),
						],
					},
					no: {
						action: {
							type: "complete",
							message:
								"Neon setup is complete. You can set up Neon Auth later by having your agent run: neon-init neon-auth",
						},
					},
				},
			},
		};
	}

	// --setup: guide through Neon Auth configuration
	if (options.setup) {
		return {
			phase: "neon_auth",
			status: "in_progress",
			nextAction: {
				type: "agent_action",
				prerequisite: SKILL_REFERENCE_URLS.neonAuth,
				steps: [
					{
						id: "provision",
						description:
							"Enable Neon Auth on the project. " +
							"Try using the Neon MCP server's provision_neon_auth tool first. " +
							"If the MCP server is not available or the tool call fails, fall back to the neonctl CLI: " +
							"`CI= npx -y neonctl neon-auth enable --project-id <project-id> --output json`. " +
							"You can also check current status with: " +
							"`CI= npx -y neonctl neon-auth status --project-id <project-id> --output json`." +
							(options.projectId
								? ` Project ID: ${options.projectId}.`
								: " Determine the project ID from the .neon file in the project root, or from the DATABASE_URL in .env, or ask the user."),
					},
					{
						id: "install_packages",
						description:
							"Install required packages per the skill reference. The exact packages depend on the framework (Next.js, React, etc.).",
					},
					{
						id: "create_components",
						description:
							"Create auth components per the skill reference. Follow the exact patterns and imports specified.",
					},
					{
						id: "wire_env",
						description:
							"Add the NEON_AUTH_* environment variables to .env as specified in the skill reference.",
					},
				],
				onComplete: {
					type: "complete",
					message:
						"Neon Auth has been configured successfully. Neon setup is complete! " +
						"Your database is connected, agent tooling is installed, and authentication is ready.",
				},
			},
		};
	}

	// Default: ask if they want Neon Auth
	return {
		phase: "neon_auth",
		status: "optional",
		nextAction: {
			type: "ask_user",
			question:
				"Would you like to set up Neon Auth for user authentication in your app?",
			options: [
				{ value: "yes", label: "Yes, set up Neon Auth" },
				{ value: "no", label: "No, skip for now" },
				{ value: "info", label: "Tell me more about Neon Auth" },
			],
			context:
				"Neon Auth provides drop-in user authentication that integrates with your Neon database.",
			responseMapping: {
				yes: {
					args: [
						"neon-auth",
						"--json",
						...(options.agent ? ["--agent", options.agent] : []),
						"--setup",
					],
				},
				no: {
					action: {
						type: "complete",
						message:
							"Neon setup is complete. You can set up Neon Auth later by having your agent run: neon-init neon-auth",
					},
				},
				info: {
					args: [
						"neon-auth",
						"--json",
						...(options.agent ? ["--agent", options.agent] : []),
						"--info",
					],
				},
			},
		},
	};
}
