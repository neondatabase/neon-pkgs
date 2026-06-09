import { getSkillsAgentName } from "../agents.js";
import { SKILL_REFERENCE_URLS } from "../skills.js";
import type { Editor, PhaseResponse } from "../types.js";

export interface SkillsPhaseOptions {
	agent?: string;
	editor?: Editor;
	status?: boolean;
	install?: boolean;
	update?: boolean;
}

export async function handleSkillsPhase(
	options: SkillsPhaseOptions,
): Promise<PhaseResponse> {
	const agentArgs = options.agent
		? ["--agent", options.agent, "--json"]
		: ["--json"];
	const skillsAgent = options.agent
		? getSkillsAgentName(options.agent)
		: "claude-code";

	// --status: ask agent to check
	if (options.status) {
		return {
			phase: "tooling",
			status: "skills_check",
			nextAction: {
				type: "agent_check",
				checks: [
					{
						id: "skills",
						description:
							"Check if Neon agent skills are installed in this project",
						lookFor: [
							"A skill file referencing 'neon-postgres' (e.g. .cursor/skills/, CLAUDE.md, .cursorrules)",
							"A .skills/ directory with neon-related content",
						],
					},
				],
				reportBack: {
					type: "run_neon_init",
					args: [
						"skills",
						"--json",
						...(options.agent ? ["--agent", options.agent] : []),
						...(options.update ? ["--update"] : ["--install"]),
					],
				},
			},
		};
	}

	// --install or --update: run the skills CLI
	if (options.install || options.update) {
		const installCmd = `npx -y skills add neondatabase/agent-skills --skill neon-postgres --agent ${skillsAgent} -y`;
		return {
			phase: "tooling",
			status: "installing_skills",
			nextAction: {
				type: "run_command",
				command: installCmd,
				description: `Installing Neon agent skills for ${skillsAgent}.`,
				timeout: 30000,
				onSuccess: {
					type: "run_neon_init",
					args: agentArgs,
				},
				onFailure: {
					other: {
						type: "run_neon_init",
						args: agentArgs,
					},
				},
			},
			skillReferences: SKILL_REFERENCE_URLS,
		};
	}

	// Default: ask if they want skills installed
	return {
		phase: "tooling",
		status: "skills_available",
		nextAction: {
			type: "ask_user",
			question:
				"Would you like to install Neon agent skills for this project? Skills provide your AI assistant with Neon-specific knowledge.",
			options: [
				{ value: "yes", label: "Yes, install skills" },
				{ value: "skip", label: "Skip for now" },
			],
			context:
				"Agent skills include guides for connection patterns, Neon Auth setup, branching, migrations, and more.",
			responseMapping: {
				yes: {
					args: [
						"skills",
						"--json",
						...(options.agent ? ["--agent", options.agent] : []),
						"--install",
					],
				},
				skip: { args: agentArgs },
			},
		},
	};
}
