import { YES_SELECTS_RECOMMENDED } from "./copy.js";
import { INIT_NEEDS_YES_OR_TERMINAL } from "./plan.js";

export type InitMode = "recommended" | "custom";

export type InitAgentSetupChoice = "plugin" | "skills-mcp" | "skip";

export type InitProjectSetupChoice = "link" | "claimable";

export type InitMcpAuthChoice = "oauth" | "api-key";

export type InitMcpScopeChoice = "global" | "project";

export type InitModeInput = {
	yes: boolean;
	interactive: boolean;
	mode?: InitMode;
	agentSetup?: InitAgentSetupChoice;
	projectSetup?: InitProjectSetupChoice;
	skills?: readonly string[];
	mcpScope?: InitMcpScopeChoice;
	mcpAuth?: InitMcpAuthChoice;
	mcpProjectId?: string;
	mcpProjectPin?: boolean;
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

const hasCustomOnlyFlags = (input: InitModeInput): boolean =>
	input.mode === "custom" ||
	input.agentSetup !== undefined ||
	input.projectSetup !== undefined ||
	(input.skills !== undefined && input.skills.length > 0) ||
	input.mcpScope !== undefined ||
	input.mcpAuth !== undefined ||
	input.mcpProjectId !== undefined ||
	input.mcpProjectPin !== undefined;

const hasExistingSetupFlags = (input: InitModeInput): boolean =>
	input.namedAgents ||
	input.noLink ||
	input.configFlag !== undefined ||
	input.services !== undefined ||
	input.hasLinkInputs;

export const resolveInitMode = (input: InitModeInput): InitModeResolution => {
	if (input.yes && hasCustomOnlyFlags(input)) {
		throw new Error(YES_SELECTS_RECOMMENDED);
	}
	if (input.yes || input.mode === "recommended") {
		return { kind: "recommended" };
	}
	if (hasCustomOnlyFlags(input) || hasExistingSetupFlags(input)) {
		return { kind: "custom" };
	}
	if (input.interactive) {
		return { kind: "ask" };
	}
	throw new Error(INIT_NEEDS_YES_OR_TERMINAL);
};
