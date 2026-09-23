import chalk from "chalk";
import prompts from "prompts";

import { CONFIG_INIT_SERVICES } from "../config_template.js";
import type { AgentType } from "../mcp/agents.js";
import { getAgentDisplayName, listMcpAgentIds } from "../mcp/agents.js";
import type { NeonService } from "../neon_services.js";
import { listSkillIds, NEON_SKILL_CATALOG } from "../skills/catalog.js";
import { canPickAgentsInteractively } from "../utils/agent_picker.js";
import type { PackageManager } from "../utils/package_manager.js";
import { installedPackageManagers } from "../utils/package_manager.js";
import {
	keepPostgresSelected,
	POSTGRES_SERVICE_CHOICE,
} from "../utils/service_picker.js";
import type { BootstrapTemplate } from "./bootstrap.js";
import { InitCancelled, throwIfAborted } from "./cancelled.js";
import {
	AGENT_DETECTED_DESCRIPTION,
	AGENT_OTHER_DESCRIPTION,
	AGENT_PICKER_MESSAGE,
	AGENT_SETUP_MESSAGE,
	AGENT_SETUP_PLUGIN_DESCRIPTION,
	AGENT_SETUP_PLUGIN_TITLE,
	AGENT_SETUP_SKILLS_DESCRIPTION,
	AGENT_SETUP_SKILLS_TITLE,
	AGENT_SETUP_SKIP_DESCRIPTION,
	AGENT_SETUP_SKIP_TITLE,
	CONFIG_CONFIRM_HINT,
	CONFIG_CONFIRM_MESSAGE,
	MCP_AUTH_API_KEY_DESCRIPTION,
	MCP_AUTH_API_KEY_TITLE,
	MCP_AUTH_MESSAGE,
	MCP_AUTH_OAUTH_DESCRIPTION,
	MCP_AUTH_OAUTH_TITLE,
	MCP_SCOPE_GLOBAL_DESCRIPTION,
	MCP_SCOPE_GLOBAL_TITLE,
	MCP_SCOPE_MESSAGE,
	MCP_SCOPE_PROJECT_DESCRIPTION,
	MCP_SCOPE_PROJECT_TITLE,
	MODE_CUSTOM_DESCRIPTION,
	MODE_CUSTOM_TITLE,
	MODE_MESSAGE,
	MODE_RECOMMENDED_DESCRIPTION,
	MODE_RECOMMENDED_TITLE,
	PACKAGE_MANAGER_MESSAGE,
	PROJECT_SETUP_CLAIMABLE_DESCRIPTION,
	PROJECT_SETUP_CLAIMABLE_TITLE,
	PROJECT_SETUP_LINK_DESCRIPTION,
	PROJECT_SETUP_LINK_TITLE,
	PROJECT_SETUP_MESSAGE,
	SERVICES_HINT,
	SERVICES_MESSAGE,
	SKILLS_PICKER_MESSAGE,
} from "./copy.js";
import type {
	InitAgentSetupChoice,
	InitMcpAuthChoice,
	InitMcpConfigLocation,
	InitMode,
	InitProjectSetupChoice,
} from "./mode.js";
import { INIT_NEEDS_YES_OR_TERMINAL } from "./plan.js";
import { formatTemplateTitle, SKIP_TEMPLATE_VALUE } from "./template_title.js";

export type InitTemplatePick =
	| { kind: "skip" }
	| { kind: "template"; template: BootstrapTemplate };

const restoreCursorOnAbort = (state: { aborted: boolean }) => {
	throwIfAborted(state);
};

const requireInteractive = (): void => {
	if (!canPickAgentsInteractively()) {
		throw new Error(INIT_NEEDS_YES_OR_TERMINAL);
	}
};

const aborted = (): never => {
	throw new InitCancelled();
};

export const pickInitModeInteractively = async (): Promise<InitMode> => {
	requireInteractive();
	const { mode } = await prompts({
		onState: restoreCursorOnAbort,
		type: "select",
		name: "mode",
		message: MODE_MESSAGE,
		initial: 0,
		choices: [
			{
				title: MODE_RECOMMENDED_TITLE,
				value: "recommended",
				description: MODE_RECOMMENDED_DESCRIPTION,
			},
			{
				title: MODE_CUSTOM_TITLE,
				value: "custom",
				description: MODE_CUSTOM_DESCRIPTION,
			},
		],
	});
	if (mode !== "recommended" && mode !== "custom") {
		return aborted();
	}
	return mode;
};

export const pickAgentSetupInteractively =
	async (): Promise<InitAgentSetupChoice> => {
		requireInteractive();
		const { setup } = await prompts({
			onState: restoreCursorOnAbort,
			type: "select",
			name: "setup",
			message: AGENT_SETUP_MESSAGE,
			initial: 0,
			choices: [
				{
					title: AGENT_SETUP_PLUGIN_TITLE,
					value: "plugin",
					description: AGENT_SETUP_PLUGIN_DESCRIPTION,
				},
				{
					title: AGENT_SETUP_SKILLS_TITLE,
					value: "skills-mcp",
					description: AGENT_SETUP_SKILLS_DESCRIPTION,
				},
				{
					title: AGENT_SETUP_SKIP_TITLE,
					value: "skip",
					description: AGENT_SETUP_SKIP_DESCRIPTION,
				},
			],
		});
		if (setup !== "plugin" && setup !== "skills-mcp" && setup !== "skip") {
			return aborted();
		}
		return setup;
	};

export const pickInitAgentsInteractively = async (input: {
	available: readonly AgentType[];
	detected: readonly AgentType[];
}): Promise<AgentType[]> => {
	requireInteractive();
	if (input.available.length === 0) {
		throw new Error("No coding agents are available to pick.");
	}
	const detected = new Set(input.detected);
	const { agents } = await prompts({
		onState: restoreCursorOnAbort,
		type: "multiselect",
		name: "agents",
		message: AGENT_PICKER_MESSAGE,
		instructions: false,
		min: 1,
		choices: input.available.map((id) => ({
			value: id,
			title: `${getAgentDisplayName(id)} (${id})`,
			description: detected.has(id)
				? AGENT_DETECTED_DESCRIPTION
				: AGENT_OTHER_DESCRIPTION,
			selected: detected.has(id),
		})),
	});
	if (!Array.isArray(agents)) {
		return aborted();
	}
	return agents.filter((id): id is AgentType => typeof id === "string");
};

export const pickInitSkillsInteractively = async (): Promise<string[]> => {
	requireInteractive();
	const { skills } = await prompts({
		onState: restoreCursorOnAbort,
		type: "multiselect",
		name: "skills",
		message: SKILLS_PICKER_MESSAGE,
		instructions: false,
		min: 1,
		choices: NEON_SKILL_CATALOG.map((entry) => ({
			value: entry.skill,
			title: entry.skill,
			selected: entry.defaultSelected,
		})),
	});
	if (!Array.isArray(skills)) {
		return aborted();
	}
	const allowed = new Set(listSkillIds());
	return skills.filter(
		(skill): skill is string =>
			typeof skill === "string" && allowed.has(skill),
	);
};

export const pickInitMcpConfigLocationInteractively =
	async (): Promise<InitMcpConfigLocation> => {
		requireInteractive();
		const { scope } = await prompts({
			onState: restoreCursorOnAbort,
			type: "select",
			name: "scope",
			message: MCP_SCOPE_MESSAGE,
			initial: 0,
			choices: [
				{
					title: MCP_SCOPE_GLOBAL_TITLE,
					value: "global",
					description: MCP_SCOPE_GLOBAL_DESCRIPTION,
				},
				{
					title: MCP_SCOPE_PROJECT_TITLE,
					value: "project",
					description: MCP_SCOPE_PROJECT_DESCRIPTION,
				},
			],
		});
		if (scope !== "global" && scope !== "project") {
			return aborted();
		}
		return scope;
	};

export const pickInitMcpAuthInteractively = async (input: {
	authenticated: boolean;
}): Promise<InitMcpAuthChoice> => {
	requireInteractive();
	const { auth } = await prompts({
		onState: restoreCursorOnAbort,
		type: "select",
		name: "auth",
		message: MCP_AUTH_MESSAGE,
		initial: input.authenticated ? 1 : 0,
		choices: [
			{
				title: MCP_AUTH_OAUTH_TITLE,
				value: "oauth",
				description: MCP_AUTH_OAUTH_DESCRIPTION,
			},
			{
				title: MCP_AUTH_API_KEY_TITLE,
				value: "api-key",
				description: MCP_AUTH_API_KEY_DESCRIPTION,
			},
		],
	});
	if (auth !== "oauth" && auth !== "api-key") {
		return aborted();
	}
	return auth;
};

export const pickInitProjectSetupInteractively =
	async (): Promise<InitProjectSetupChoice> => {
		requireInteractive();
		const { setup } = await prompts({
			onState: restoreCursorOnAbort,
			type: "select",
			name: "setup",
			message: PROJECT_SETUP_MESSAGE,
			initial: 0,
			choices: [
				{
					title: PROJECT_SETUP_LINK_TITLE,
					value: "link",
					description: PROJECT_SETUP_LINK_DESCRIPTION,
				},
				{
					title: PROJECT_SETUP_CLAIMABLE_TITLE,
					value: "claimable",
					description: PROJECT_SETUP_CLAIMABLE_DESCRIPTION,
				},
			],
		});
		if (setup !== "link" && setup !== "claimable") {
			return aborted();
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
		return aborted();
	}
	const selected = templates.find((template) => template.id === id);
	if (selected === undefined) {
		return aborted();
	}
	return { kind: "template", template: selected };
};

export const pickInitConfigInteractively = async (): Promise<boolean> => {
	requireInteractive();
	process.stdout.write(`${chalk.dim(CONFIG_CONFIRM_HINT)}\n`);
	const { value } = await prompts({
		onState: restoreCursorOnAbort,
		type: "confirm",
		name: "value",
		message: CONFIG_CONFIRM_MESSAGE,
		initial: true,
	});
	if (value === undefined) {
		return aborted();
	}
	return value === true;
};

export const pickInitServicesInteractively = async (): Promise<
	NeonService[]
> => {
	requireInteractive();
	process.stdout.write(`${chalk.dim(SERVICES_HINT)}\n`);
	const question = {
		onState: restoreCursorOnAbort,
		onRender() {
			keepPostgresSelected(this);
		},
		type: "multiselect" as const,
		name: "services" as const,
		message: SERVICES_MESSAGE,
		instructions: false,
		cursor: 1,
		choices: [
			POSTGRES_SERVICE_CHOICE,
			{
				value: "auth",
				title: "Managed Better Auth",
				description:
					"Declare managed authentication for users and sessions.",
			},
			{
				value: "data-api",
				title: "Data API",
				description:
					"Declare an HTTP API for Postgres. Also declares Managed Better Auth.",
			},
			{
				value: "functions",
				title: "Functions",
				description:
					"Declare a hello function and add its source file.",
			},
			{
				value: "object-storage",
				title: "Object Storage",
				description:
					"Declare a private S3-compatible bucket named assets.",
			},
			{
				value: "ai-gateway",
				title: "AI Gateway",
				description:
					"Declare AI Gateway access. Requires an eligible Neon plan.",
			},
		],
	};
	const { services } = await prompts(question);
	if (!Array.isArray(services)) {
		return aborted();
	}
	return CONFIG_INIT_SERVICES.filter((service) => services.includes(service));
};

export const pickInitPackageManagerInteractively = async (): Promise<
	PackageManager | undefined
> => {
	requireInteractive();
	const available = installedPackageManagers();
	if (available.length <= 1) {
		return available[0];
	}
	const initial = Math.max(0, available.indexOf("npm"));
	const { pm } = await prompts({
		onState: restoreCursorOnAbort,
		type: "select",
		name: "pm",
		message: PACKAGE_MANAGER_MESSAGE,
		initial,
		choices: available.map((id) => ({
			title: id,
			value: id,
		})),
	});
	if (pm !== "npm" && pm !== "pnpm" && pm !== "yarn" && pm !== "bun") {
		return aborted();
	}
	return pm;
};

export const pickInitLinkInteractively = async (): Promise<boolean> => {
	requireInteractive();
	const { value } = await prompts({
		onState: restoreCursorOnAbort,
		type: "confirm",
		name: "value",
		message: "Link this project to a Neon project now?",
		initial: true,
	});
	if (value === undefined) {
		return aborted();
	}
	return value === true;
};

export const initAgentIds = (): AgentType[] => listMcpAgentIds();
