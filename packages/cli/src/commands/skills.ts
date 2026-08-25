import type yargs from "yargs";

import { getAgentDisplayName } from "../init/agents.js";
import { log } from "../log.js";
import { assertSkillsCanRun, resolveSkillsPlan } from "../skills/plan.js";
import {
	npxCommand,
	runSkillsCli,
	skillsAddArgs,
	skillsMetadata,
	skillsUpdateArgs,
	skillsUpdateDetail,
	skillsUpdateHadNothing,
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
	scope: string;
	source: string;
	skills: string;
	agents: string;
	status: "installed" | "failed";
	error?: string;
};

type SkillsUpdateRow = {
	scope: string;
	status: "updated" | "none" | "failed";
	detail?: string;
	error?: string;
};

const scopeLabel = (scope: "global" | "project"): string =>
	scope === "project" ? "this directory" : "user-level";

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
					.hide("agent")
					.check((args) => {
						noPassthrough("skills update")(args);
						const agents = args.agent;
						if (Array.isArray(agents) && agents.length > 0) {
							throw new Error(
								"neon skills update does not take --agent. It refreshes every installed skill in this directory (or --global).",
							);
						}
						return true;
					}),
			(args) => updateHandler(args as unknown as SkillsProps),
		)
		.options({
			yes: {
				alias: "y",
				type: "boolean",
				default: false,
				describe: "Skip prompts",
			},
			global: {
				type: "boolean",
				default: false,
				describe:
					"Install user-level skills (skills CLI -g). Default is this directory",
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
	const failed: { label: string; message: string; args: string[] }[] = [];
	const scope = scopeLabel(plan.scope);
	for (const invocation of plan.invocations) {
		const skills =
			invocation.skills === "*" ? "*" : invocation.skills.join(", ");
		const args = skillsAddArgs({
			source: invocation.source,
			skills: invocation.skills,
			agents: mapped,
			global: plan.scope === "global",
			metadata,
		});
		try {
			await runSkillsCli({
				args,
				cwd,
			});
			rows.push({
				scope,
				source: invocation.source,
				skills,
				agents: mapped.join(", "),
				status: "installed",
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			rows.push({
				scope,
				source: invocation.source,
				skills,
				agents: mapped.join(", "),
				status: "failed",
				error: "skills CLI failed",
			});
			failed.push({
				label: `${invocation.source} (${skills})`,
				message,
				args,
			});
		}
	}

	const out = writer(props);
	out.write(rows, {
		fields: ["scope", "source", "skills", "agents", "status", "error"],
		title: "Skills",
	});
	out.end();

	if (failed.length === 0) {
		log.info(
			plan.scope === "project"
				? "Wrote skills in this directory."
				: "Wrote user-level skills.",
		);
		return;
	}
	const first = failed[0];
	if (first === undefined) {
		throw new Error("Failed to install Neon agent skills.");
	}
	const retry = npxCommand(first.args);
	if (first.message.includes("needs npx (Node.js)")) {
		throw new Error(first.message);
	}
	if (failed.length === rows.length) {
		throw new Error(`${first.message}\nRetry with: ${retry}`);
	}
	throw new Error(
		`Failed to install Neon agent skills for: ${failed.map((row) => row.label).join(", ")}.\n${first.message}\nRetry with: ${retry}`,
	);
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
	const args = skillsUpdateArgs({ global: scope === "global" });
	let failure: string | undefined;
	try {
		const result = await runSkillsCli({
			args,
			cwd,
		});
		const output = `${result.stdout}\n${result.stderr}`;
		rows.push({
			scope: scopeLabel(scope),
			status: skillsUpdateHadNothing(output) ? "none" : "updated",
			detail: skillsUpdateDetail(output),
		});
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
		rows.push({
			scope: scopeLabel(scope),
			status: "failed",
			error: "skills CLI failed",
		});
	}

	const out = writer(props);
	out.write(rows, {
		fields: ["scope", "status", "detail", "error"],
		title: "Skills",
	});
	out.end();

	if (failure !== undefined) {
		throw new Error(
			failure.includes("needs npx (Node.js)")
				? failure
				: `${failure}\nRetry with: ${npxCommand(args)}`,
		);
	}
};
