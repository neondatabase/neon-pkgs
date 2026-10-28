import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { redactCredentialTokenIds, trackEvent } from "../analytics.js";
import { codeFromBody, isNeonApiError } from "../api.js";
import { AuthRefreshError } from "../auth.js";
import { type ErrorCode, isNetworkError, matchErrorCode } from "../errors.js";
import type { AgentType } from "../mcp/agents.js";
import type { NeonService } from "../neon_services.js";
import pkg from "../pkg.js";
import type { InitDetection } from "./detect.js";
import type { InitAgentSetupChoice, InitMode } from "./mode.js";

export const CLI_INIT_START = "cli_init_start";
export const CLI_INIT_END = "cli_init_end";

export type InitFunnelAgentSetup =
	| InitAgentSetupChoice
	| "skills"
	| "mcp"
	| "mixed";

export type InitFunnelLink =
	| "linked"
	| "skipped"
	| "claimable"
	| "already_linked";

export type InitFunnelConfig = "created" | "existing" | "skipped";

export type InitFunnelOutcome = "success" | "pending" | "error" | "aborted";

/** `setup` is everything after `cli_init_start` and before the first install or link. */
export type InitFunnelErrorStep =
	| "setup"
	| "plugins"
	| "skills"
	| "mcp"
	| "link"
	| "claimable"
	| "config"
	| "env_pull";

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
	/** The failure `neon init` exited with, which `CLI Error` reports too; else the first recorded. */
	error_step: InitFunnelErrorStep | null;
	error_code: ErrorCode | null;
	error_message: string | null;
	/** Every step that failed, in order. */
	error_steps: InitFunnelErrorStep[];
};

const FLAG_ALIASES: Readonly<Record<string, string>> = {
	"-y": "--yes",
	"--yes": "--yes",
	"--default": "--yes",
	"-a": "--agent",
	"--agent": "--agent",
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
	"--claimable": "--claimable",
	"--package-manager": "--package-manager",
	"--skill": "--skill",
	"--mcp-config-location": "--mcp-config-location",
	"--mcp-auth": "--mcp-auth",
	"--mcp-project-scoped": "--mcp-project-scoped",
	"--no-agent-setup": "--no-agent-setup",
	"--agent-setup": "--agent-setup",
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

export type InitFunnelError = {
	step: InitFunnelErrorStep;
	error: unknown;
};

/** Longer messages are cut so one plugin CLI dump cannot dominate the event. */
const ERROR_MESSAGE_LIMIT = 2_000;

/**
 * The `errCode` the top-level failure handler (`index.ts`) sends on `CLI Error` for the same
 * error, so a run's `error_code` and its `CLI Error` event agree.
 */
export const initErrorCode = (error: unknown): ErrorCode => {
	if (error instanceof AuthRefreshError) {
		return "AUTH_FAILED";
	}
	if (isNetworkError(error)) {
		return "NETWORK_ERROR";
	}
	if (isNeonApiError(error)) {
		if (error.code === "ECONNABORTED") {
			return "REQUEST_TIMEOUT";
		}
		const bodyCode = codeFromBody(error.data);
		if (
			error.status === 401 ||
			bodyCode === "SSO_AUTHORIZATION_REQUIRED" ||
			bodyCode === "SSO_ORG_CREDS_ONLY"
		) {
			return "AUTH_FAILED";
		}
		return "API_ERROR";
	}
	return matchErrorCode(error instanceof Error ? error.message : undefined);
};

export const initErrorMessage = (error: unknown): string => {
	const raw = error instanceof Error ? error.message : String(error);
	return redactCredentialTokenIds(stripVTControlCharacters(raw)).slice(
		0,
		ERROR_MESSAGE_LIMIT,
	);
};

export const initEndProperties = (input: {
	initRunId: string;
	mode: InitMode | null;
	agentSetup: InitFunnelAgentSetup | null;
	agentsInstalled: AgentType[];
	link: InitFunnelLink | null;
	config: InitFunnelConfig | null;
	services: NeonService[] | null;
	outcome: InitFunnelOutcome;
	errors: readonly InitFunnelError[];
	exitError?: unknown;
}): InitFunnelEnd => {
	const reported =
		input.errors.find((entry) => entry.error === input.exitError) ??
		input.errors[0];
	return {
		init_run_id: input.initRunId,
		cli_version: pkg.version,
		mode: input.mode,
		agent_setup: input.agentSetup,
		agents_installed: input.agentsInstalled,
		link: input.link,
		config: input.config,
		services: input.services,
		outcome: input.outcome,
		error_step: reported?.step ?? null,
		error_code:
			reported === undefined ? null : initErrorCode(reported.error),
		error_message:
			reported === undefined ? null : initErrorMessage(reported.error),
		error_steps: [...new Set(input.errors.map((entry) => entry.step))],
	};
};

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
	errors: InitFunnelError[];
	exitError: unknown;
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
	errors: [],
	exitError: undefined,
	ended: false,
});

/** Records a failure once: a deferred error rethrown at the end keeps the step it failed in. */
export const recordInitError = (
	state: InitFunnelState,
	step: InitFunnelErrorStep,
	error: unknown,
): void => {
	if (state.errors.some((entry) => entry.error === error)) {
		return;
	}
	state.errors.push({ step, error });
};

export const recordInitExit = (
	state: InitFunnelState,
	step: InitFunnelErrorStep,
	error: unknown,
): void => {
	recordInitError(state, step, error);
	state.exitError = error;
};

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
			errors: state.errors,
			exitError: state.exitError,
		}),
	);
};
