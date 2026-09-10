import chalk from "chalk";
import prompts from "prompts";

import { NEON_PLUGIN_NAME } from "../plugins/run.js";
import { canPickAgentsInteractively } from "../utils/agent_picker.js";
import type { BootstrapTemplate } from "./bootstrap.js";
import { INIT_NEEDS_YES_OR_TERMINAL, type InitAgentSetup } from "./plan.js";
import { formatTemplateTitle, SKIP_TEMPLATE_VALUE } from "./template_title.js";

export type InitTemplatePick =
	| { kind: "skip" }
	| { kind: "template"; template: BootstrapTemplate };

const restoreCursorOnAbort = (state: { aborted: boolean }) => {
	if (state.aborted) {
		process.stdout.write("\x1B[?25h");
		process.stdout.write("\n");
		process.exit(1);
	}
};

const requireInteractive = (): void => {
	if (!canPickAgentsInteractively()) {
		throw new Error(INIT_NEEDS_YES_OR_TERMINAL);
	}
};

export const pickAgentSetupInteractively =
	async (): Promise<InitAgentSetup> => {
		requireInteractive();
		const { setup } = await prompts({
			onState: restoreCursorOnAbort,
			type: "select",
			name: "setup",
			message: "How would you like to set up your coding agents?",
			initial: 0,
			choices: [
				{
					title: "Neon plugin (recommended)",
					value: "plugin",
					description: `Install ${NEON_PLUGIN_NAME} (skills and MCP together)`,
				},
				{
					title: "Skills and MCP separately",
					value: "skills-mcp",
					description: "Install skills, then the MCP server",
				},
				{
					title: "Skip agent setup",
					value: "skip",
					description: "Continue to project setup",
				},
			],
		});
		if (setup !== "plugin" && setup !== "skills-mcp" && setup !== "skip") {
			throw new Error("Aborted.");
		}
		return setup;
	};

export type InitTemplateChoice = {
	title: string;
	value: string;
	description: string;
};

/** First catalog template; skip is index 0 so it stays on the first screen. */
export const INIT_TEMPLATE_PICKER_INITIAL = 1;

export const initTemplatePickerChoices = (
	templates: readonly BootstrapTemplate[],
): InitTemplateChoice[] => {
	if (templates.length === 0) {
		throw new Error("No templates available to scaffold from.");
	}
	return [
		{
			title: "Skip the template",
			value: SKIP_TEMPLATE_VALUE,
			description:
				"Set up agents and link a Neon project without copying template files.",
		},
		...templates.map((template) => ({
			title: formatTemplateTitle(template),
			value: template.id,
			description: template.description ?? "",
		})),
	];
};

export const pickInitTemplateInteractively = async (
	templates: readonly BootstrapTemplate[],
): Promise<InitTemplatePick> => {
	requireInteractive();
	const choices = initTemplatePickerChoices(templates);
	const { id } = await prompts({
		onState: restoreCursorOnAbort,
		type: "select",
		name: "id",
		message: "How would you like to set up this directory?",
		initial: INIT_TEMPLATE_PICKER_INITIAL,
		choices,
	});
	if (id === SKIP_TEMPLATE_VALUE) {
		return { kind: "skip" };
	}
	if (typeof id !== "string" || id.length === 0) {
		throw new Error("Aborted.");
	}
	const selected = templates.find((template) => template.id === id);
	if (selected === undefined) {
		throw new Error("Aborted.");
	}
	return { kind: "template", template: selected };
};

export const pickInitConfigInteractively = async (): Promise<boolean> => {
	requireInteractive();
	process.stdout.write(
		`${chalk.dim("Choose services, then edit neon.ts and apply changes with neon config apply.")}\n`,
	);
	const { value } = await prompts({
		onState: restoreCursorOnAbort,
		type: "confirm",
		name: "value",
		message: "Create neon.ts to manage this project's Neon setup as code?",
		initial: true,
	});
	if (value === undefined) {
		throw new Error("Aborted.");
	}
	return value === true;
};
