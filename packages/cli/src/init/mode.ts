import { NO_AGENT_SETUP_CONFLICT, NON_TTY_AGENT_SETUP } from "./copy.js";
import { INIT_NEEDS_YES_OR_TERMINAL } from "./plan.js";

export type InitMode = "recommended" | "custom";

export type InitAgentSetupChoice = "plugin" | "skills-mcp" | "skip";

export type InitProjectSetupChoice = "link" | "claimable";

export type InitMcpAuthChoice = "oauth" | "api-key";

export type InitMcpScopeChoice = "global" | "project";

export type InitModeInput = {
	yes: boolean;
	interactive: boolean;
	skipAgents: boolean;
	claimable: boolean;
	skills?: readonly string[];
	mcpScope?: InitMcpScopeChoice;
	mcpAuth?: InitMcpAuthChoice;
	mcpProjectScoped?: boolean;
	namedAgents: boolean;
	configFlag?: boolean;
	services?: readonly string[];
	noLink: boolean;
	hasLinkInputs: boolean;
};

export type InitModeResolution =
	| { kind: "recommended" }
	| { kind: "custom" }
	| { kind: "ask" };

export type InitAgentSetupInference =
	| { kind: "skip" }
	| { kind: "skills" }
	| { kind: "skills-mcp" }
	| { kind: "auto" }
	| { kind: "ask" };

export const hasInitMcpFlags = (input: {
	mcpScope?: InitMcpScopeChoice;
	mcpAuth?: InitMcpAuthChoice;
	mcpProjectScoped?: boolean;
}): boolean =>
	input.mcpScope !== undefined ||
	input.mcpAuth !== undefined ||
	input.mcpProjectScoped === true;

const hasSkillsFlag = (skills: readonly string[] | undefined): boolean =>
	skills !== undefined && skills.length > 0;

const hasCustomizingFlags = (input: InitModeInput): boolean =>
	input.skipAgents ||
	input.claimable ||
	hasSkillsFlag(input.skills) ||
	hasInitMcpFlags(input);

const hasExistingSetupFlags = (input: InitModeInput): boolean =>
	input.namedAgents ||
	input.noLink ||
	input.configFlag !== undefined ||
	input.services !== undefined ||
	input.hasLinkInputs;

export const resolveInitMode = (input: InitModeInput): InitModeResolution => {
	if (hasCustomizingFlags(input)) {
		return { kind: "custom" };
	}
	if (input.yes) {
		return { kind: "recommended" };
	}
	if (hasExistingSetupFlags(input)) {
		return { kind: "custom" };
	}
	if (input.interactive) {
		return { kind: "ask" };
	}
	throw new Error(INIT_NEEDS_YES_OR_TERMINAL);
};

export const assertAgentSetupFlags = (input: {
	skipAgents: boolean;
	namedAgents: boolean;
	skills?: readonly string[];
	mcpScope?: InitMcpScopeChoice;
	mcpAuth?: InitMcpAuthChoice;
	mcpProjectScoped?: boolean;
}): void => {
	if (!input.skipAgents) {
		return;
	}
	if (
		input.namedAgents ||
		hasSkillsFlag(input.skills) ||
		hasInitMcpFlags(input)
	) {
		throw new Error(NO_AGENT_SETUP_CONFLICT);
	}
};

export const inferInitAgentSetup = (input: {
	skipAgents: boolean;
	skills?: readonly string[];
	hasMcpFlags: boolean;
	namedAgents: boolean;
	yes: boolean;
	canAsk: boolean;
}): InitAgentSetupInference => {
	if (input.skipAgents) {
		return { kind: "skip" };
	}
	const hasSkills = hasSkillsFlag(input.skills);
	if (hasSkills && input.hasMcpFlags) {
		return { kind: "skills-mcp" };
	}
	if (hasSkills) {
		return { kind: "skills" };
	}
	if (input.hasMcpFlags) {
		return { kind: "skills-mcp" };
	}
	if (input.namedAgents || input.yes) {
		return { kind: "auto" };
	}
	if (input.canAsk) {
		return { kind: "ask" };
	}
	throw new Error(NON_TTY_AGENT_SETUP);
};
