import { randomUUID } from "node:crypto";
import { trackEvent } from "../analytics.js";
import type { AgentType } from "../mcp/agents.js";
import type { NeonService } from "../neon_services.js";
import pkg from "../pkg.js";
import type { InitDetection } from "./detect.js";
import type { InitAgentSetupChoice, InitMode } from "./mode.js";

export const CLI_INIT_START = "cli_init_start";
export const CLI_INIT_END = "cli_init_end";

export type InitFunnelAgentSetup = InitAgentSetupChoice | "skills" | "mixed";

export type InitFunnelLink =
	| "linked"
	| "skipped"
	| "claimable"
	| "already_linked";

export type InitFunnelConfig = "created" | "existing" | "skipped";

export type InitFunnelOutcome = "success" | "pending" | "error" | "aborted";

export type InitFunnelStart = {
	init_run_id: string;
	cli_version: string;
	flags: string[];
	authenticated: boolean;
	empty_directory: boolean;
	interactive: boolean;
	host_agent: AgentType | null;
	detected_agents: AgentType[];
	ci: boolean;
};

export type InitFunnelEnd = {
	init_run_id: string;
	cli_version: string;
	mode: InitMode | null;
	agent_setup: InitFunnelAgentSetup | null;
	agents_installed: AgentType[];
	link: InitFunnelLink | null;
	config: InitFunnelConfig | null;
	services: NeonService[] | null;
	outcome: InitFunnelOutcome;
};

const FLAG_ALIASES: Readonly<Record<string, string>> = {
	"-y": "--yes",
	"--yes": "--yes",
	"--default": "--yes",
	"-a": "--agent",
	"--agent": "--agent",
	"--skip-template": "--skip-template",
	"--template": "--template",
	"--no-link": "--no-link",
	"--link": "--link",
	"--no-config": "--no-config",
	"--config": "--config",
	"--services": "--services",
	"--org-id": "--org-id",
	"--project-id": "--project-id",
	"--project-name": "--project-name",
	"--region-id": "--region-id",
	"--branch": "--branch",
	"--branch-id": "--branch",
	"--mode": "--mode",
	"--agent-setup": "--agent-setup",
	"--project-setup": "--project-setup",
	"--package-manager": "--package-manager",
	"--skill": "--skill",
	"--mcp-scope": "--mcp-scope",
	"--mcp-auth": "--mcp-auth",
	"--mcp-project-id": "--mcp-project-id",
	"--no-mcp-project-pin": "--no-mcp-project-pin",
	"--mcp-project-pin": "--mcp-project-pin",
	"--no-analytics": "--no-analytics",
	"--analytics": "--analytics",
	"--profile": "--profile",
	"--config-dir": "--config-dir",
	"--api-host": "--api-host",
	"--context-file": "--context-file",
	"--force-auth": "--force-auth",
	"--no-force-auth": "--no-force-auth",
};

const flagName = (token: string): string | undefined => {
	const raw = token.split("=")[0];
	if (raw === undefined) {
		return undefined;
	}
	return FLAG_ALIASES[raw];
};

export const initFlagsFromArgv = (argv: readonly string[]): string[] => {
	const initAt = argv.lastIndexOf("init");
	const slice = initAt >= 0 ? argv.slice(initAt + 1) : argv;
	const flags: string[] = [];
	const seen = new Set<string>();
	for (const token of slice) {
		if (token === "--") {
			break;
		}
		if (!token.startsWith("-")) {
			continue;
		}
		const name = flagName(token);
		if (name === undefined || seen.has(name)) {
			continue;
		}
		seen.add(name);
		flags.push(name);
	}
	return flags;
};

export const createInitRunId = (): string => randomUUID();

export const initStartProperties = (input: {
	initRunId: string;
	argv?: readonly string[];
	detection: InitDetection;
}): InitFunnelStart => ({
	init_run_id: input.initRunId,
	cli_version: pkg.version,
	flags: initFlagsFromArgv(input.argv ?? process.argv),
	authenticated: input.detection.authenticated,
	empty_directory: input.detection.emptyDirectory,
	interactive: input.detection.interactive,
	host_agent: input.detection.hostAgent,
	detected_agents: input.detection.detectedAgents,
	ci: input.detection.ci,
});

export const initEndProperties = (input: {
	initRunId: string;
	mode: InitMode | null;
	agentSetup: InitFunnelAgentSetup | null;
	agentsInstalled: AgentType[];
	link: InitFunnelLink | null;
	config: InitFunnelConfig | null;
	services: NeonService[] | null;
	outcome: InitFunnelOutcome;
}): InitFunnelEnd => ({
	init_run_id: input.initRunId,
	cli_version: pkg.version,
	mode: input.mode,
	agent_setup: input.agentSetup,
	agents_installed: input.agentsInstalled,
	link: input.link,
	config: input.config,
	services: input.services,
	outcome: input.outcome,
});

export const emitInitStart = (properties: InitFunnelStart): void => {
	trackEvent(CLI_INIT_START, properties);
};

export const emitInitEnd = (properties: InitFunnelEnd): void => {
	trackEvent(CLI_INIT_END, properties);
};

export type InitFunnelState = {
	initRunId: string;
	mode: InitMode | null;
	agentSetup: InitFunnelAgentSetup | null;
	agentsInstalled: AgentType[];
	link: InitFunnelLink | null;
	config: InitFunnelConfig | null;
	services: NeonService[] | null;
	ended: boolean;
};

export const createInitFunnel = (
	initRunId = createInitRunId(),
): InitFunnelState => ({
	initRunId,
	mode: null,
	agentSetup: null,
	agentsInstalled: [],
	link: null,
	config: null,
	services: null,
	ended: false,
});

export const finishInitFunnel = (
	state: InitFunnelState,
	outcome: InitFunnelOutcome,
	analytics: boolean,
): void => {
	if (state.ended || !analytics) {
		return;
	}
	state.ended = true;
	emitInitEnd(
		initEndProperties({
			initRunId: state.initRunId,
			mode: state.mode,
			agentSetup: state.agentSetup,
			agentsInstalled: state.agentsInstalled,
			link: state.link,
			config: state.config,
			services: state.services,
			outcome,
		}),
	);
};
