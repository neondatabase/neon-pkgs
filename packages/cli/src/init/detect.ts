import { existsSync, readdirSync } from "node:fs";
import {
	credentialInputs,
	selectCredential,
} from "@neon-internals/cli-core/auth_selection";
import {
	DEFAULT_PROFILE,
	locationOf,
	resolveProfile,
} from "@neon-internals/cli-core/profiles";
import { detectProjectAgents } from "add-mcp";
import { storeFor } from "../credential_io.js";
import { isCi } from "../env.js";
import type { AgentType } from "../mcp/agents.js";
import { canPickAgentsInteractively } from "../utils/agent_picker.js";
import { detectInstalledAgents, uniqueAgentIds } from "./agents.js";
import { detectAgent } from "./detect_host.js";
import { directoryIsEmpty } from "./plan.js";

export type InitDetection = {
	authenticated: boolean;
	emptyDirectory: boolean;
	interactive: boolean;
	hostAgent: AgentType | null;
	detectedAgents: AgentType[];
	ci: boolean;
};

export type DetectInitEnvironmentOptions = {
	cwd: string;
	configDir: string;
	detectProjectAgents?: (
		cwd: string,
	) => readonly AgentType[] | Promise<readonly AgentType[]>;
	detectInstalledAgents?: () => Promise<readonly AgentType[]>;
	detectAgent?: () => AgentType | null;
	hasLocalCredentials?: (configDir: string) => boolean;
	directoryNames?: readonly string[];
	interactive?: boolean;
};

const listingHasCredentials = (configDir: string, profile: string): boolean => {
	try {
		const listing = storeFor(configDir).inspect(
			locationOf(resolveProfile(configDir, profile)),
		);
		return listing.credentials !== null;
	} catch {
		return false;
	}
};

export const hasLocalCredentials = (configDir: string): boolean => {
	const inputs = credentialInputs();
	const selection = selectCredential({
		apiKeyFlag: inputs.apiKeyFlag,
		profileFlag: inputs.profileFlag,
		apiKeyEnv: inputs.apiKeyEnv,
		profileEnv: inputs.profileEnv,
	});
	if (
		selection.source === "explicit-api-key" ||
		selection.source === "ambient-api-key"
	) {
		return true;
	}
	const dir = configDir || inputs.configDir;
	if (!dir) {
		return false;
	}
	return listingHasCredentials(dir, selection.profile || DEFAULT_PROFILE);
};

export const collectDetectedAgents = (input: {
	host: AgentType | null;
	project: readonly AgentType[];
	global: readonly AgentType[];
}): AgentType[] =>
	uniqueAgentIds([
		...input.global,
		...input.project,
		...(input.host === null ? [] : [input.host]),
	]);

export const detectInitEnvironment = async (
	options: DetectInitEnvironmentOptions,
): Promise<InitDetection> => {
	const names =
		options.directoryNames ??
		(existsSync(options.cwd) ? readdirSync(options.cwd) : []);
	const host = (options.detectAgent ?? detectAgent)();
	const project = await (options.detectProjectAgents ?? detectProjectAgents)(
		options.cwd,
	);
	const globalAgents = await (
		options.detectInstalledAgents ?? detectInstalledAgents
	)();
	const detectedAgents = collectDetectedAgents({
		host,
		project,
		global: globalAgents,
	});
	return {
		authenticated: (options.hasLocalCredentials ?? hasLocalCredentials)(
			options.configDir,
		),
		emptyDirectory: directoryIsEmpty(names),
		interactive: options.interactive ?? canPickAgentsInteractively(),
		hostAgent: host,
		detectedAgents,
		ci: isCi(),
	};
};
