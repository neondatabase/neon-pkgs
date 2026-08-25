import type yargs from "yargs";

import { getAgentDisplayName } from "../init/agents.js";
import { log } from "../log.js";
import { assertSkillsCanRun, resolveSkillsPlan } from "../skills/plan.js";
import {
	runSkillsCli,
	skillsAddArgs,
	skillsMetadata,
	skillsUpdateArgs,
} from "../skills/run.js";
import { mappedSkillsAgentNames } from "../skills/targets.js";
import { confirmSkillsInstall, confirmSkillsUpdate } from "../skills/wizard.js";
import type { CommonProps } from "../types.js";
import { canPickAgentsInteractively } from "../utils/agent_picker.js";
import { noPassthrough } from "../utils/flags.js";
import { writer } from "../writer.js";

type SkillsProps = CommonProps & {
	yes?: boolean;
	global?: boolean;
	agent?: string[];
};

type SkillsInstallRow = {
	source: string;
	skills: string;
	agents: string;
	status: "installed" | "failed";
	error?: string;
};

type SkillsUpdateRow = {
	scope: string;
	status: "updated" | "failed";
	error?: string;
};

const coerceAgents = (value: unknown): string[] => {
	if (value === undefined) return [];
	const list = Array.isArray(value) ? value : [value];
	if (list.length === 0) {
		throw new Error(
			"--agent needs a value. Pass one, or omit the flag entirely.",
		);
	}
	return list.map((item) => {
		if (typeof item !== "string" || item.trim() === "") {
			throw new Error(
				"--agent needs a value. Pass one, or omit the flag entirely.",
			);
		}
		return item;
	});
};

export const command = "skills";
export const describe = "Install Neon agent skills into coding agents";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 skills [command] [options]")
		.command(
			"update",
			"Update installed skills to the latest versions",
			(yargs) =>
				yargs
					.usage("$0 skills update [options]")
					.options({
						yes: {
							alias: "y",
							type: "boolean",
							default: false,
							describe:
								"Skip prompts. Update installed skills in this directory",
						},
						global: {
							type: "boolean",
							default: false,
							describe:
								"Update user-level skills (skills CLI -g). Default is this directory",
						},
					})
					.example(
						"$0 skills update",
						"Interactive: confirm, then update skills in this directory",
					)
					.example(
						"$0 skills update -y",
						"Update skills in this directory without prompting",
					)
					.example(
						"$0 skills update --global -y",
						"Update user-level skills",
					)
					.strict()
					.check(noPassthrough("skills update")),
			(args) => updateHandler(args as unknown as SkillsProps),
		)
		.options({
			yes: {
				alias: "y",
				type: "boolean",
				default: false,
				describe:
					"Skip prompts. Installs every skill from neondatabase/agent-skills into detected agents in this directory. --agent and --global still apply",
			},
			global: {
				type: "boolean",
				default: false,
				describe:
					"Install user-level skills (skills CLI -g). Default is this directory. Skips nothing else",
			},
			agent: {
				alias: "a",
				type: "array",
				string: true,
				describe:
					"Coding agent to install into (repeatable). Skips the agent picker",
				coerce: coerceAgents,
			},
		})
		.example(
			"$0 skills",
			"Interactive: this directory, agents, skills, then confirm",
		)
		.example(
			"$0 skills -y",
			"This directory, detected agents, every skill from neondatabase/agent-skills",
		)
		.example(
			"$0 skills --agent cursor --agent claude-code",
			"Install into specific agents",
		)
		.example("$0 skills --global", "Install user-level skills")
		.strict()
		.check(noPassthrough("skills"));

export const handler = async (props: SkillsProps) => {
	const cwd = process.cwd();
	const yes = props.yes === true;
	const interactive = canPickAgentsInteractively() && !yes;
	const plan = await resolveSkillsPlan({
		global: props.global === true,
		agents: props.agent ?? [],
		yes,
		cwd,
		interactive,
	});
	const mapped = mappedSkillsAgentNames(plan.agents);
	for (const agent of plan.skipped) {
		log.warning(
			"Skipping %s: no skills mapping.",
			getAgentDisplayName(agent),
		);
	}

	if (interactive) {
		const ok = await confirmSkillsInstall({
			scope: plan.scope,
			agents: plan.agents,
			invocations: plan.invocations,
		});
		if (!ok) {
			log.info("Aborted. Nothing was written.");
			return;
		}
	}

	const metadata = skillsMetadata("skills");
	const rows: SkillsInstallRow[] = [];
	const failed: string[] = [];
	for (const invocation of plan.invocations) {
		const skills =
			invocation.skills === "*" ? "*" : invocation.skills.join(", ");
		try {
			await runSkillsCli({
				args: skillsAddArgs({
					source: invocation.source,
					skills: invocation.skills,
					agents: mapped,
					global: plan.scope === "global",
					metadata,
				}),
				cwd,
			});
			rows.push({
				source: invocation.source,
				skills,
				agents: mapped.join(", "),
				status: "installed",
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			rows.push({
				source: invocation.source,
				skills,
				agents: mapped.join(", "),
				status: "failed",
				error: message,
			});
			failed.push(`${invocation.source} (${skills})`);
		}
	}

	const out = writer(props);
	out.write(rows, {
		fields: ["source", "skills", "agents", "status", "error"],
		title: "Skills",
	});
	out.end();

	if (failed.length === rows.length) {
		throw new Error(
			rows[0]?.error ?? "Failed to install Neon agent skills.",
		);
	}
	if (failed.length > 0) {
		throw new Error(
			`Failed to install Neon agent skills for: ${failed.join(", ")}.`,
		);
	}
};

const updateHandler = async (props: SkillsProps) => {
	const cwd = process.cwd();
	const yes = props.yes === true;
	const interactive = canPickAgentsInteractively() && !yes;
	assertSkillsCanRun({ yes, interactive, action: "update" });
	const scope = props.global === true ? "global" : "project";

	if (interactive) {
		const ok = await confirmSkillsUpdate({ scope });
		if (!ok) {
			log.info("Aborted. Nothing was written.");
			return;
		}
	}

	const rows: SkillsUpdateRow[] = [];
	try {
		await runSkillsCli({
			args: skillsUpdateArgs({ global: scope === "global" }),
			cwd,
		});
		rows.push({
			scope: scope === "project" ? "this directory" : "user-level",
			status: "updated",
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		rows.push({
			scope: scope === "project" ? "this directory" : "user-level",
			status: "failed",
			error: message,
		});
	}

	const out = writer(props);
	out.write(rows, {
		fields: ["scope", "status", "error"],
		title: "Skills",
	});
	out.end();

	if (rows[0]?.status === "failed") {
		throw new Error("Failed to update installed skills.");
	}
};
