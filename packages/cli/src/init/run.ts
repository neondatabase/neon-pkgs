import { resolve } from "node:path";
import {
	type CommandAgentSetup,
	recordCommandSuccessExtras,
	takeCommandSuccessExtras,
} from "../analytics.js";
import { DEFAULT_CLAIMABLE_ORIGIN } from "../claimable/api.js";
import { readLinkedClaimableCredentials } from "../claimable/state.js";
import { create as createClaimableProject } from "../commands/claim.js";
import { ConfigInstallFailed, initCmd } from "../commands/config.js";
import type { EnvPullProps, PullOutcome } from "../commands/env.js";
import { quoteFlagValue, runLink } from "../commands/link.js";
import { defaultDir } from "../config.js";
import {
	CONFIG_INIT_SERVICES,
	parseConfigInitServices,
} from "../config_template.js";
import { contextBranch, readContextFile } from "../context.js";
import { log } from "../log.js";
import { type AgentType, getAgentDisplayName } from "../mcp/agents.js";
import { CannotMintApiKeyError } from "../mcp/mint.js";
import { mcpInstallableAgents } from "../mcp/targets.js";
import { type NeonService, servicesFlagValue } from "../neon_services.js";
import {
	type MissingPluginsCommand,
	missingPluginsCommands,
	pluginsInstallableAgents,
} from "../plugins/targets.js";
import { hasNeonConfigFile, neonConfigFilename } from "../project.js";
import { skillsInstallableAgents } from "../skills/targets.js";
import type { CommonProps } from "../types.js";
import { getCliName } from "../utils/cli_name.js";
import {
	inferPackageManager,
	type PackageManager,
	resolvePackageManager,
} from "../utils/package_manager.js";
import {
	pullInitEnv as defaultPullInitEnv,
	type InitAuthOptions,
} from "./auth.js";
import { InitCancelled, raceSigint, restoreCursor } from "./cancelled.js";
import {
	configPlanFromResolution,
	INIT_CONFIG_SERVICES_CONFLICT,
	resolveInitConfigChoice,
	shouldPullEnvAfterInitConfig,
} from "./choices.js";
import {
	agentsRowValue,
	configRowValue,
	formatInitDone,
	headingForKind,
	printInitBanner,
	printInitDone,
	printInitProgress,
	projectRowValue,
	shouldPrintInitBanner,
} from "./chrome.js";
import {
	CANCELLED_BODY,
	CLAIMABLE_ACCOUNT_FLAGS,
	CLAIMABLE_ALREADY_LINKED,
	CLAIMABLE_MCP_API_KEY,
	CLAIMABLE_NO_LINK,
	claimableNext,
	claimableThenServicesNext,
	envPullFailedNext,
	existingConfigNext,
	extraServicesNext,
	installFailedNext,
	MCP_API_KEY_NEEDS_AUTH,
	MCP_SCOPED_NEEDS_PROJECT,
	type McpKeyFailure,
	mcpAfterLinkNext,
	mcpConfigLocationSkipped,
	mcpConfigLocationUnavailable,
	mcpKeyFailedNext,
	NO_AGENTS_FALLBACK_STATUS,
	NON_TTY_LINK_NEEDS_AUTH,
	namedAgentsUnavailable,
	offlinePinNext,
	PROGRESS,
	PROJECT_PINNED_OFFLINE,
	skippedLinkNext,
	unattendedUnauthedNext,
} from "./copy.js";
import { detectInitEnvironment } from "./detect.js";
import {
	createInitFunnel,
	emitInitStart,
	finishInitFunnel,
	type InitFunnelAgentSetup,
	type InitFunnelOutcome,
	initStartProperties,
} from "./funnel.js";
import {
	type InitLinkInputs,
	type InitLinkProps,
	type RunLink,
	runAuthenticatedLink,
} from "./link.js";
import type {
	InitAgentSetupChoice,
	InitMcpAuthChoice,
	InitMcpConfigLocation,
	InitMode,
	InitProjectSetupChoice,
} from "./mode.js";
import {
	assertAgentSetupFlags,
	hasInitMcpFlags,
	inferInitAgentSetup,
	resolveInitMode,
} from "./mode.js";
import {
	assertNamedAgentTooling,
	FALLBACK_SKILLS_AGENTS,
	funnelAgentSetup,
	type InitToolingPlan,
	planInitToolingSteps,
	recommendedTooling,
	resolveNamedAgents,
	splitInitTooling,
} from "./plan.js";
import { runToolingSteps, type ToolingOperations } from "./tooling.js";
import {
	pickAgentSetupInteractively,
	pickInitAgentsInteractively,
	pickInitConfigInteractively,
	pickInitMcpAuthInteractively,
	pickInitMcpConfigLocationInteractively,
	pickInitModeInteractively,
	pickInitPackageManagerInteractively,
	pickInitProjectSetupInteractively,
	pickInitServicesInteractively,
	pickInitSkillsInteractively,
} from "./wizard.js";

export type InitConfigFn = (input: {
	cwd: string;
	services?: readonly string[];
	packageManager?: PackageManager;
	install: boolean;
}) => Promise<void>;

export type InitClaimFn = (input: {
	cwd: string;
	configDir: string;
	contextFile: string;
	output: "yaml" | "json" | "table";
	apiKey: string;
	profile?: string;
}) => Promise<void>;

export type InitProps = CommonProps & {
	yes?: boolean;
	agent?: string[];
	skill?: string[];
	configDir?: string;
	profile?: string;
	oauthHost?: string;
	clientId?: string;
	forceAuth?: boolean;
	allowUnsafeTls?: boolean;
	analytics?: boolean;
	data?: string;
	cwd?: string;
	link?: boolean;
	config?: boolean;
	services?: unknown;
	orgId?: string;
	projectId?: string;
	projectName?: string;
	regionId?: string;
	branch?: string;
	agentSetup?: boolean;
	claimable?: boolean;
	packageManager?: PackageManager;
	mcpConfigLocation?: InitMcpConfigLocation;
	mcpAuth?: InitMcpAuthChoice;
	mcpProjectScoped?: boolean;
	/** Overrides the plugins/skills/mcp install functions (tests). Production calls the real ones in-process — see `packages/cli/AGENTS.md`. */
	operations?: Partial<ToolingOperations>;
	pickMode?: () => Promise<InitMode>;
	pickAgentSetup?: () => Promise<InitAgentSetupChoice>;
	pickAgents?: (input: {
		available: readonly AgentType[];
		detected: readonly AgentType[];
		setup: "plugin" | "skills" | "mcp";
	}) => Promise<AgentType[] | undefined>;
	pickSkills?: () => Promise<string[]>;
	pickMcpConfigLocation?: () => Promise<InitMcpConfigLocation>;
	pickMcpAuth?: (input: {
		authenticated: boolean;
	}) => Promise<InitMcpAuthChoice>;
	pickProjectSetup?: () => Promise<InitProjectSetupChoice>;
	pickConfig?: () => Promise<boolean>;
	pickServices?: () => Promise<NeonService[]>;
	pickPackageManager?: () => Promise<PackageManager | undefined>;
	linkProject?: RunLink;
	createClaimable?: InitClaimFn;
	initConfig?: InitConfigFn;
	/** Overrides the trailing `env pull` (tests). Production calls the real one in-process. */
	envPull?: (props: EnvPullProps & InitAuthOptions) => Promise<PullOutcome>;
	detectProjectAgents?: (
		cwd: string,
	) => readonly AgentType[] | Promise<readonly AgentType[]>;
	detectInstalledAgents?: () => Promise<readonly AgentType[]>;
	detectAgent?: () => AgentType | null;
	hasLocalCredentials?: (configDir: string) => boolean;
	hasProjectPlugins?: (cwd: string) => Promise<boolean>;
};

const isLinked = (contextFile: string): boolean => {
	const projectId = readContextFile(contextFile).projectId;
	return typeof projectId === "string" && projectId.length > 0;
};

type FlagPairs = [string, string | undefined][];

const commandLine = (command: string, pairs: FlagPairs): string =>
	[
		`${getCliName()} ${command}`,
		...pairs.flatMap(([flag, value]) =>
			value === undefined ? [] : [`${flag} ${quoteFlagValue(value)}`],
		),
	].join(" ");

const deferredLinkCommands = (
	props: InitProps,
	inputs: InitLinkInputs,
): { login: string; link: string; envPull: string } => {
	const session: FlagPairs = [
		["--profile", props.profile],
		[
			"--config-dir",
			props.configDir === defaultDir ? undefined : props.configDir,
		],
	];
	const context: FlagPairs = [
		[
			"--context-file",
			props.contextFile === ".neon" ? undefined : props.contextFile,
		],
	];
	return {
		login: commandLine("login", session),
		link: commandLine("link", [
			["--org-id", inputs.orgId],
			["--project-id", inputs.projectId],
			["--project-name", inputs.projectName],
			["--region-id", inputs.regionId],
			["--branch", inputs.branch],
			...context,
			...session,
		]),
		envPull: commandLine("env pull", [...context, ...session]),
	};
};

const expandTelemetryServices = (
	services: readonly NeonService[],
): NeonService[] => {
	if (services.includes("data-api") && !services.includes("auth")) {
		return CONFIG_INIT_SERVICES.filter(
			(service) => service === "auth" || services.includes(service),
		);
	}
	return [...services];
};

const extrasSetup = (
	setup: InitFunnelAgentSetup | null,
): CommandAgentSetup | undefined => {
	if (setup === null) {
		return undefined;
	}
	return setup;
};

const pluginScopeFor = (
	agents: readonly AgentType[],
	preferred: "global" | "project",
): "global" | "project" => {
	if (preferred === "global") {
		return "global";
	}
	const project = new Set(pluginsInstallableAgents("project"));
	const globalOnly = agents.some(
		(id) =>
			!project.has(id) && pluginsInstallableAgents("global").includes(id),
	);
	return globalOnly ? "global" : "project";
};

const warnMissingPluginCommands = (
	missing: readonly MissingPluginsCommand[],
	tooling: InitToolingPlan,
): void => {
	if (tooling.setup !== "skills-mcp" && tooling.setup !== "mixed") {
		return;
	}
	const routed = new Set([...tooling.skillsAgents, ...tooling.mcpAgents]);
	for (const { agent, command } of missing) {
		if (routed.has(agent)) {
			log.warning(
				'%s: "%s" was not found on PATH, so its plugin cannot install. Installing Neon skills and MCP instead.',
				getAgentDisplayName(agent),
				command,
			);
		}
	}
};

const nonEmptyAgents = (
	ids: readonly AgentType[],
	fallback: boolean,
): [AgentType, ...AgentType[]] | undefined => {
	const [first, ...rest] = ids;
	if (first !== undefined) {
		return [first, ...rest];
	}
	if (fallback) {
		return FALLBACK_SKILLS_AGENTS;
	}
	return undefined;
};

const skillsTooling = (
	ids: readonly AgentType[],
	fallback: boolean,
): InitToolingPlan => {
	const agents = nonEmptyAgents(
		ids.filter((id) => skillsInstallableAgents().includes(id)),
		fallback,
	);
	if (agents === undefined) {
		return { setup: "skip" };
	}
	return { setup: "skills", agents };
};

const skillsMcpTooling = (
	skillsSelection: readonly AgentType[] | undefined,
	mcpSelection: readonly AgentType[] | undefined,
	mcpConfigLocation: InitMcpConfigLocation,
	fallback: boolean,
): InitToolingPlan => {
	// The fallback is for "no agents detected at all". An MCP-only agent leaves the
	// skills selection empty, and that must not pull in the fallback skills agents.
	const useFallback =
		fallback && skillsSelection?.length === 0 && mcpSelection?.length === 0;
	const selectedSkills = (
		useFallback ? FALLBACK_SKILLS_AGENTS : (skillsSelection ?? [])
	).filter((id) => skillsInstallableAgents().includes(id));
	const selectedMcp = (
		useFallback ? FALLBACK_SKILLS_AGENTS : (mcpSelection ?? [])
	).filter((id) => mcpInstallableAgents(mcpConfigLocation).includes(id));
	if (selectedMcp.length === 0) {
		return skillsTooling(selectedSkills, false);
	}
	return {
		setup: "skills-mcp",
		skillsAgents: selectedSkills,
		mcpAgents: selectedMcp,
	};
};

const validateMcpConfigLocationSupport = (
	ids: readonly AgentType[],
	location: "global" | "project",
): void => {
	const supported = new Set(mcpInstallableAgents(location));
	const unavailable = ids.filter((id) => !supported.has(id));
	if (unavailable.length === 0) {
		return;
	}
	if (unavailable.length < ids.length) {
		log.warning(mcpConfigLocationSkipped(unavailable, location));
		return;
	}
	throw new Error(mcpConfigLocationUnavailable(unavailable, location));
};

const pickOrDetectAgents = async (input: {
	named: readonly AgentType[];
	available: readonly AgentType[];
	detected: readonly AgentType[];
	pickAgents?: InitProps["pickAgents"];
	/** What the picker preselects when it differs from what `-y` would install. */
	preselected?: readonly AgentType[];
	missingCommands?: readonly MissingPluginsCommand[];
	interactive: boolean;
	setup: "plugin" | "skills" | "mcp";
}): Promise<AgentType[] | undefined> => {
	if (input.named.length > 0) {
		const selected = input.named.filter((id) =>
			input.available.includes(id),
		);
		const dropped = input.named.filter(
			(id) => !input.available.includes(id),
		);
		if (dropped.length > 0) {
			throw new Error(namedAgentsUnavailable(dropped));
		}
		return selected;
	}
	const detected = input.detected.filter((id) =>
		input.available.includes(id),
	);
	const preselected = (input.preselected ?? input.detected).filter((id) =>
		input.available.includes(id),
	);
	if (input.pickAgents !== undefined) {
		return input.pickAgents({
			available: [...input.available],
			detected: preselected,
			setup: input.setup,
		});
	}
	if (input.interactive) {
		return pickInitAgentsInteractively({
			available: [...input.available],
			detected,
			preselected,
			...(input.missingCommands !== undefined
				? { missingCommands: input.missingCommands }
				: {}),
			setup: input.setup,
		});
	}
	return detected;
};

const defaultInitConfig: InitConfigFn = async (input) => {
	await initCmd({
		cwd: input.cwd,
		install: input.install,
		silent: true,
		requireInstall: true,
		...(input.services !== undefined ? { services: input.services } : {}),
		...(input.packageManager !== undefined
			? { packageManager: input.packageManager }
			: {}),
	});
};

const defaultCreateClaimable: InitClaimFn = async (input) => {
	await createClaimableProject({
		_: ["claim", "create"],
		output: input.output,
		configDir: input.configDir,
		contextFile: input.contextFile,
		claimableHost:
			process.env.CLAIMABLE_NEON_HOST ?? DEFAULT_CLAIMABLE_ORIGIN,
		apiKey: input.apiKey,
		envPull: false,
		cwd: input.cwd,
		...(input.profile !== undefined ? { profile: input.profile } : {}),
	});
};

export const runInit = async (props: InitProps): Promise<void> => {
	if (props.output === "json" || props.output === "yaml") {
		throw new Error(
			`\`${getCliName()} init\` does not support --output. The commands it runs print their own output.`,
		);
	}

	const cwd = props.cwd ?? process.cwd();
	const contextFile = resolve(cwd, props.contextFile);
	const yes = props.yes === true;
	const analytics = props.analytics !== false;
	const named = resolveNamedAgents(props.agent ?? []);
	assertNamedAgentTooling(named, "init", yes ? { yes: true } : undefined);
	assertAgentSetupFlags({
		skipAgents: props.agentSetup === false,
		namedAgents: named.length > 0,
		...(props.skill !== undefined ? { skills: props.skill } : {}),
		...(props.mcpConfigLocation !== undefined
			? { mcpConfigLocation: props.mcpConfigLocation }
			: {}),
		...(props.mcpAuth !== undefined ? { mcpAuth: props.mcpAuth } : {}),
		...(props.mcpProjectScoped === true ? { mcpProjectScoped: true } : {}),
	});
	const configDir = props.configDir ?? defaultDir;
	// plugins/skills need no Neon auth at all; mcp/env pull resolve it themselves, in-process,
	// exactly as the standalone commands do (see `init/auth.ts`) — this is that shared context.
	const auth: InitAuthOptions = {
		apiClient: props.apiClient,
		apiKey: props.apiKey,
		apiHost: props.apiHost,
		contextFile,
		...(props.configDir ? { configDir: props.configDir } : {}),
		...(props.profile ? { profile: props.profile } : {}),
		...(props.oauthHost ? { oauthHost: props.oauthHost } : {}),
		...(props.clientId ? { clientId: props.clientId } : {}),
		...(props.forceAuth !== undefined
			? { forceAuth: props.forceAuth }
			: {}),
		...(props.allowUnsafeTls !== undefined
			? { allowUnsafeTls: props.allowUnsafeTls }
			: {}),
	};
	// Raw values, because `config init` parses them again and warns about retired spellings.
	// Parsed here only so a bad value fails before any setup step runs.
	const servicesFlag = servicesFlagValue(props.services);
	if (props.config === false && servicesFlag !== undefined) {
		throw new Error(INIT_CONFIG_SERVICES_CONFLICT);
	}
	if (servicesFlag !== undefined) {
		parseConfigInitServices(servicesFlag);
	}
	const linkInputs: InitLinkInputs = {
		...(props.orgId ? { orgId: props.orgId } : {}),
		...(props.projectId ? { projectId: props.projectId } : {}),
		...(props.projectName ? { projectName: props.projectName } : {}),
		...(props.regionId ? { regionId: props.regionId } : {}),
		...(props.branch ? { branch: props.branch } : {}),
	};
	const hasExplicitLinkInputs =
		props.orgId !== undefined ||
		props.projectId !== undefined ||
		props.projectName !== undefined ||
		props.regionId !== undefined ||
		props.branch !== undefined;

	const funnel = createInitFunnel();
	let outcome: InitFunnelOutcome = "error";
	let printed = false;

	try {
		const detectOpts = {
			cwd,
			configDir,
			...(props.detectProjectAgents
				? { detectProjectAgents: props.detectProjectAgents }
				: {}),
			...(props.detectInstalledAgents
				? { detectInstalledAgents: props.detectInstalledAgents }
				: {}),
			...(props.detectAgent ? { detectAgent: props.detectAgent } : {}),
			...(props.hasLocalCredentials
				? { hasLocalCredentials: props.hasLocalCredentials }
				: {}),
			interactive: yes ? false : undefined,
		};
		const detection = await detectInitEnvironment(detectOpts);
		if (yes) {
			detection.interactive = false;
		}
		if (analytics) {
			emitInitStart(
				initStartProperties({
					initRunId: funnel.initRunId,
					detection,
				}),
			);
		}

		if (shouldPrintInitBanner(yes)) {
			printInitBanner();
		}

		const skipAgents = props.agentSetup === false;
		const modeArgs = {
			yes,
			interactive:
				detection.interactive ||
				props.pickMode !== undefined ||
				props.pickAgentSetup !== undefined,
			skipAgents,
			namedAgents: named.length > 0,
			noLink: props.link === false,
			hasLinkInputs: hasExplicitLinkInputs,
			claimable: props.claimable === true,
			...(props.skill !== undefined ? { skills: props.skill } : {}),
			...(props.mcpConfigLocation !== undefined
				? { mcpConfigLocation: props.mcpConfigLocation }
				: {}),
			...(props.mcpAuth !== undefined ? { mcpAuth: props.mcpAuth } : {}),
			...(props.mcpProjectScoped === true
				? { mcpProjectScoped: true }
				: {}),
			...(props.config !== undefined ? { configFlag: props.config } : {}),
			...(servicesFlag !== undefined ? { services: servicesFlag } : {}),
		};
		resolveInitMode(modeArgs);

		const modeResolution = resolveInitMode({
			...modeArgs,
			interactive:
				detection.interactive ||
				props.pickMode !== undefined ||
				props.pickAgentSetup !== undefined,
		});

		const mode: InitMode =
			modeResolution.kind === "ask"
				? props.pickMode !== undefined
					? await props.pickMode()
					: props.pickAgentSetup !== undefined ||
							props.pickProjectSetup !== undefined ||
							props.pickConfig !== undefined
						? "custom"
						: await pickInitModeInteractively()
				: modeResolution.kind;
		funnel.mode = mode;

		const alreadyLinked = isLinked(contextFile);
		const existingConfig = hasNeonConfigFile(cwd);
		const existingFilename = neonConfigFilename(cwd);
		const claimableExisting =
			alreadyLinked &&
			readLinkedClaimableCredentials(
				configDir,
				readContextFile(contextFile),
			) !== null;

		if (props.claimable === true) {
			if (props.link === false) {
				throw new Error(CLAIMABLE_NO_LINK);
			}
			if (hasExplicitLinkInputs) {
				throw new Error(CLAIMABLE_ACCOUNT_FLAGS);
			}
			if (alreadyLinked) {
				throw new Error(CLAIMABLE_ALREADY_LINKED);
			}
		}

		const recommended = mode === "recommended";
		const targets = named.length > 0 ? named : detection.detectedAgents;
		const missingPluginCommands = missingPluginsCommands(targets, { cwd });
		const unavailablePluginAgents = missingPluginCommands.map(
			(row) => row.agent,
		);
		const pluginReady = (agents: readonly AgentType[]): AgentType[] =>
			agents.filter((id) => !unavailablePluginAgents.includes(id));

		let tooling: InitToolingPlan = { setup: "skip" };
		let mcpAuth: InitMcpAuthChoice | undefined = props.mcpAuth;
		let mcpAuthChosen = props.mcpAuth !== undefined;
		let mcpConfigLocation: InitMcpConfigLocation =
			props.mcpConfigLocation ?? "global";
		let selectedSkills: readonly string[] | undefined = props.skill;
		let delayMcp = false;
		let pluginScope: "global" | "project" = recommended
			? "global"
			: "project";

		if (recommended) {
			pluginScope = "global";
			tooling =
				named.length > 0
					? splitInitTooling(
							named,
							"global",
							"global",
							unavailablePluginAgents,
						)
					: recommendedTooling(
							detection.detectedAgents,
							unavailablePluginAgents,
						);
			if (named.length === 0 && detection.detectedAgents.length === 0) {
				printInitProgress(NO_AGENTS_FALLBACK_STATUS);
			}
			warnMissingPluginCommands(missingPluginCommands, tooling);
			mcpAuth =
				!detection.authenticated &&
				(tooling.setup === "skills-mcp" || tooling.setup === "mixed")
					? "oauth"
					: mcpAuth;
		} else {
			const inferred = inferInitAgentSetup({
				skipAgents,
				hasMcpFlags: hasInitMcpFlags(props),
				namedAgents: named.length > 0,
				yes,
				canAsk:
					detection.interactive || props.pickAgentSetup !== undefined,
				...(props.skill !== undefined ? { skills: props.skill } : {}),
			});
			if (inferred.kind === "skip") {
				tooling = { setup: "skip" };
			} else if (inferred.kind === "auto") {
				const autoAgents =
					named.length > 0 ? named : detection.detectedAgents;
				pluginScope = pluginScopeFor(
					pluginReady(autoAgents),
					"project",
				);
				tooling = splitInitTooling(
					autoAgents,
					pluginScope,
					mcpConfigLocation,
					unavailablePluginAgents,
				);
				warnMissingPluginCommands(missingPluginCommands, tooling);
				if (tooling.setup === "skip" && yes && named.length === 0) {
					tooling = recommendedTooling([]);
					printInitProgress(NO_AGENTS_FALLBACK_STATUS);
				}
			} else {
				const setup: InitAgentSetupChoice | "skills" =
					inferred.kind === "ask"
						? await (
								props.pickAgentSetup ??
								pickAgentSetupInteractively
							)()
						: inferred.kind;
				if (setup !== "skip") {
					pluginScope = pluginScopeFor(targets, "project");
					const namedFallback = named.length === 0;
					const pickAgents = (
						setup: "plugin" | "skills" | "mcp",
						available: readonly AgentType[],
					) =>
						pickOrDetectAgents({
							named,
							available,
							detected: detection.detectedAgents,
							...(setup === "plugin"
								? {
										preselected: pluginReady(
											detection.detectedAgents,
										),
										missingCommands: missingPluginCommands,
									}
								: {}),
							interactive: detection.interactive,
							setup,
							pickAgents: props.pickAgents,
						});
					if (setup === "plugin" || setup === "skills") {
						const available =
							setup === "plugin"
								? uniqueAgents([
										...pluginsInstallableAgents("project"),
										...pluginsInstallableAgents("global"),
									])
								: [...skillsInstallableAgents()];
						const selected = await pickAgents(setup, available);
						if (selected === undefined) {
							tooling = { setup: "skip" };
						} else if (setup === "plugin") {
							pluginScope = pluginScopeFor(selected, pluginScope);
							tooling = splitInitTooling(
								selected.filter((id) =>
									pluginsInstallableAgents(
										pluginScope,
									).includes(id),
								),
								pluginScope,
							);
						} else {
							tooling = skillsTooling(selected, namedFallback);
						}
					} else {
						const skillsAvailable = skillsInstallableAgents();
						const skillsSelection =
							named.length > 0
								? named.filter((id) =>
										skillsAvailable.includes(id),
									)
								: await pickAgents("skills", skillsAvailable);
						if (
							skillsSelection !== undefined &&
							selectedSkills === undefined &&
							inferred.kind === "ask"
						) {
							selectedSkills =
								props.pickSkills !== undefined
									? await props.pickSkills()
									: detection.interactive
										? await pickInitSkillsInteractively()
										: undefined;
						}
						const mcpSelection =
							named.length > 0
								? named
								: // Unfiltered by location so validateMcpConfigLocationSupport
									// rejects or warns about agents the location cannot serve.
									await pickAgents(
										"mcp",
										mcpInstallableAgents("global"),
									);
						if (mcpSelection !== undefined) {
							mcpConfigLocation =
								props.mcpConfigLocation ??
								(yes
									? "global"
									: props.pickMcpConfigLocation !== undefined
										? await props.pickMcpConfigLocation()
										: detection.interactive
											? await pickInitMcpConfigLocationInteractively()
											: "global");
							if (mcpSelection.length > 0) {
								validateMcpConfigLocationSupport(
									mcpSelection,
									mcpConfigLocation,
								);
							}
							const pickAuth =
								props.pickMcpAuth ??
								(detection.interactive
									? pickInitMcpAuthInteractively
									: undefined);
							const chosenAuth =
								props.mcpAuth ??
								(yes
									? undefined
									: await pickAuth?.({
											authenticated:
												detection.authenticated,
										}));
							mcpAuthChosen = chosenAuth !== undefined;
							mcpAuth =
								chosenAuth ??
								(detection.authenticated &&
								props.claimable !== true
									? "api-key"
									: "oauth");
						}
						tooling = skillsMcpTooling(
							skillsSelection,
							mcpSelection,
							mcpConfigLocation,
							namedFallback,
						);
					}
				}
			}
		}

		funnel.agentSetup = funnelAgentSetup(tooling);

		const usesMcp =
			(tooling.setup === "skills-mcp" || tooling.setup === "mixed") &&
			tooling.mcpAgents.length > 0;
		if (
			mcpAuth === undefined &&
			usesMcp &&
			(!detection.authenticated || props.claimable === true)
		) {
			mcpAuth = "oauth";
		}
		delayMcp =
			usesMcp &&
			(mcpAuth === "api-key" || props.mcpProjectScoped === true);

		const mcpOauth = mcpAuth === "oauth";
		const earlyTooling = delayMcp ? withoutMcp(tooling) : tooling;
		// Reported after the remaining steps run, so one missing MCP key does not
		// leave the directory without a link or neon.ts.
		const mcpState: {
			error?: Error;
			reason?: McpKeyFailure;
			pinId?: string;
			/** Formatted `--project-id` value for MCP that waits on a deferred link. */
			deferredPin?: string;
		} = {};
		const reportedTooling = (): InitToolingPlan =>
			mcpState.error === undefined && mcpState.deferredPin === undefined
				? tooling
				: withoutMcp(tooling);
		const mcpCommand = (projectIdArg: string | undefined): string =>
			[
				`${getCliName()} mcp -y`,
				...(mcpConfigLocation === "project" ? ["--project"] : []),
				...(projectIdArg !== undefined
					? [`--project-id ${projectIdArg}`]
					: []),
				...("mcpAgents" in tooling ? tooling.mcpAgents : []).map(
					(agent) => `--agent ${agent}`,
				),
			].join(" ");
		const mcpFailedNext = (): string[] =>
			mcpState.error === undefined
				? []
				: mcpKeyFailedNext(
						mcpState.reason ?? "cannot-mint",
						mcpCommand(
							mcpState.pinId !== undefined
								? quoteFlagValue(mcpState.pinId)
								: undefined,
						),
					);
		const mcpDeferredNext = (): string[] =>
			mcpState.deferredPin === undefined
				? []
				: mcpAfterLinkNext(
						`${mcpCommand(mcpState.deferredPin)}${mcpOauth ? " --oauth" : ""}`,
					);
		const runTooling = async (
			steps: ReturnType<typeof planInitToolingSteps>,
			plan: InitToolingPlan,
		): Promise<void> => {
			let ran = plan;
			try {
				await runToolingSteps(steps, {
					cwd,
					output: props.output,
					auth,
					operations: props.operations,
					narrate: "human",
					mcpOauthFallback: !mcpAuthChosen,
				});
			} catch (error) {
				if (!(error instanceof CannotMintApiKeyError)) {
					throw error;
				}
				mcpState.error = error;
				mcpState.reason = "cannot-mint";
				ran = withoutMcp(plan);
			}
			funnel.agentsInstalled = uniqueAgents([
				...funnel.agentsInstalled,
				...agentsFromTooling(ran),
			]);
		};

		const toolingSteps = planInitToolingSteps({
			tooling: earlyTooling,
			yes: true,
			pluginScope,
			skillsGlobal: recommended,
			mcpOauth,
			mcpProject: mcpConfigLocation === "project",
			...(selectedSkills !== undefined ? { skills: selectedSkills } : {}),
		});
		if (toolingSteps.length > 0) {
			await runTooling(toolingSteps, earlyTooling);
		}

		let projectSetup: InitProjectSetupChoice | "skip" | "already" = "skip";
		let linkedNow = false;
		let claimExpiresAt: string | undefined;
		const noLink = props.link === false;
		// -y never opens a browser, so without credentials it leaves linking as a next step.
		const linkByDefault =
			detection.authenticated || (hasExplicitLinkInputs && !yes);

		if (noLink) {
			funnel.link = alreadyLinked ? "already_linked" : "skipped";
			projectSetup = "skip";
		} else if (alreadyLinked && !hasExplicitLinkInputs) {
			funnel.link = claimableExisting ? "claimable" : "already_linked";
			projectSetup = "already";
			if (claimableExisting) {
				const stored = readLinkedClaimableCredentials(
					configDir,
					readContextFile(contextFile),
				);
				claimExpiresAt = stored?.expiresAt;
			}
		} else if (recommended) {
			if (linkByDefault) {
				projectSetup = "link";
			} else if (detection.interactive && !yes) {
				projectSetup = "link";
			} else {
				projectSetup = "skip";
				funnel.link = "skipped";
			}
		} else if (props.claimable === true) {
			projectSetup = "claimable";
		} else if (linkByDefault) {
			projectSetup = "link";
		} else if (yes) {
			projectSetup = "skip";
			funnel.link = "skipped";
		} else if (
			props.pickProjectSetup !== undefined ||
			detection.interactive
		) {
			projectSetup = await (
				props.pickProjectSetup ?? pickInitProjectSetupInteractively
			)();
		} else {
			throw new Error(NON_TTY_LINK_NEEDS_AUTH);
		}

		const linkProps: InitLinkProps = {
			apiClient: props.apiClient,
			apiKey: props.apiKey,
			apiHost: props.apiHost,
			output: props.output,
			contextFile,
			yes,
			clear: false,
			checks: true,
			envPull: true,
			config: false,
			cwd,
			...linkInputs,
			...(props.configDir ? { configDir: props.configDir } : {}),
			...(props.profile ? { profile: props.profile } : {}),
			...(props.oauthHost ? { oauthHost: props.oauthHost } : {}),
			...(props.clientId ? { clientId: props.clientId } : {}),
			...(props.forceAuth !== undefined
				? { forceAuth: props.forceAuth }
				: {}),
			...(props.allowUnsafeTls !== undefined
				? { allowUnsafeTls: props.allowUnsafeTls }
				: {}),
		};

		if (
			usesMcp &&
			mcpAuth === "api-key" &&
			(projectSetup === "claimable" || props.claimable === true)
		) {
			throw new Error(CLAIMABLE_MCP_API_KEY);
		}

		if (projectSetup === "claimable") {
			printInitProgress(PROGRESS.claim);
			const createClaim = props.createClaimable ?? defaultCreateClaimable;
			await createClaim({
				cwd,
				configDir,
				contextFile,
				output: props.output,
				apiKey: props.apiKey,
				...(props.profile !== undefined
					? { profile: props.profile }
					: {}),
			});
			linkedNow = true;
			funnel.link = "claimable";
			const stored = readLinkedClaimableCredentials(
				configDir,
				readContextFile(contextFile),
			);
			claimExpiresAt = stored?.expiresAt;
		} else if (projectSetup === "link") {
			printInitProgress(
				detection.authenticated ? PROGRESS.link : PROGRESS.auth,
			);
			const linkProject = props.linkProject ?? runAuthenticatedLink;
			await linkProject(linkProps);
			linkedNow = true;
			funnel.link = "linked";
		}

		// With org, project, and branch all named, the pin needs no API call. Neon
		// verifies it on the first command that reaches it.
		const pinnedOffline =
			funnel.link === "skipped" &&
			!noLink &&
			linkInputs.orgId !== undefined &&
			linkInputs.projectId !== undefined &&
			linkInputs.branch !== undefined &&
			linkInputs.projectName === undefined &&
			linkInputs.regionId === undefined;
		if (pinnedOffline) {
			await runLink({ ...linkProps, checks: false, envPull: false });
			linkedNow = true;
			funnel.link = "linked";
		}

		if (
			delayMcp &&
			tooling.setup !== "skip" &&
			props.mcpProjectScoped === true &&
			funnel.link === "skipped" &&
			!noLink
		) {
			// The pin would name the old project, or none, until the deferred link runs.
			mcpState.deferredPin =
				linkInputs.projectId !== undefined
					? quoteFlagValue(linkInputs.projectId)
					: "<project-id>";
		} else if (
			delayMcp &&
			tooling.setup !== "skip" &&
			mcpAuth === "api-key" &&
			// Only -y is still signed out here; without it, link may have signed in.
			yes &&
			!detection.authenticated
		) {
			mcpState.error = new Error(MCP_API_KEY_NEEDS_AUTH);
			mcpState.reason = "signed-out";
			const linkedId = readContextFile(contextFile).projectId;
			if (
				props.mcpProjectScoped === true &&
				typeof linkedId === "string"
			) {
				mcpState.pinId = linkedId;
			}
		} else if (delayMcp && tooling.setup !== "skip") {
			const linkedId = readContextFile(contextFile).projectId;
			let pinId: string | undefined;
			if (props.mcpProjectScoped === true) {
				if (typeof linkedId !== "string" || linkedId.length === 0) {
					throw new Error(MCP_SCOPED_NEEDS_PROJECT);
				}
				pinId = linkedId;
			}
			const mcpOnly: InitToolingPlan =
				tooling.setup === "skills-mcp"
					? {
							setup: "skills-mcp",
							skillsAgents: [],
							mcpAgents: tooling.mcpAgents,
						}
					: tooling.setup === "mixed"
						? {
								setup: "skills-mcp",
								skillsAgents: [],
								mcpAgents: tooling.mcpAgents,
							}
						: { setup: "skip" };
			const mcpSteps = planInitToolingSteps({
				tooling: mcpOnly,
				yes: true,
				pluginScope,
				skillsGlobal: recommended,
				mcpOauth,
				mcpProject: mcpConfigLocation === "project",
				...(pinId !== undefined ? { mcpProjectId: pinId } : {}),
			});
			mcpState.pinId = pinId;
			if (mcpSteps.length > 0) {
				await runTooling(mcpSteps, mcpOnly);
			}
		}

		const canAskConfig =
			props.pickConfig !== undefined || detection.interactive;
		const configResolution = resolveInitConfigChoice({
			flag: recommended ? (props.config ?? true) : props.config,
			yes: recommended || yes,
			canAsk: canAskConfig,
			existingConfig,
			...(servicesFlag !== undefined ? { services: servicesFlag } : {}),
		});
		const accepted =
			configResolution.kind === "ask"
				? await (props.pickConfig ?? pickInitConfigInteractively)()
				: undefined;
		let configPlan = configPlanFromResolution(configResolution, accepted);

		if (
			configPlan.kind === "write" &&
			!existingConfig &&
			configPlan.services === undefined &&
			!recommended &&
			servicesFlag === undefined &&
			(detection.interactive || props.pickServices !== undefined)
		) {
			const picked = await (
				props.pickServices ?? pickInitServicesInteractively
			)();
			configPlan = {
				kind: "write",
				services: picked.length === 0 ? ["postgres"] : picked,
			};
		}

		if (recommended && configPlan.kind === "write" && !existingConfig) {
			configPlan = {
				kind: "write",
				services: servicesFlag ?? ["postgres"],
			};
		}

		let wroteNewFile = false;
		let extraServices = false;
		let selectedServices: NeonService[] | null = null;
		if (configPlan.kind === "write") {
			const planned = existingConfig
				? undefined
				: (configPlan.services ?? ["postgres"]);
			if (planned !== undefined) {
				const declared = parseConfigInitServices(planned);
				extraServices = declared.length > 0;
				selectedServices = expandTelemetryServices(declared);
				funnel.services = selectedServices;
				wroteNewFile = true;
			} else {
				selectedServices = null;
			}
			let pm = props.packageManager;
			if (pm === undefined) {
				pm = recommended
					? resolvePackageManager(cwd)
					: inferPackageManager(cwd);
			}
			if (pm === undefined) {
				if (
					props.pickPackageManager !== undefined ||
					detection.interactive
				) {
					pm =
						(await (
							props.pickPackageManager ??
							pickInitPackageManagerInteractively
						)()) ?? resolvePackageManager(cwd);
				} else {
					pm = resolvePackageManager(cwd);
				}
			}
			if (!existingConfig) {
				printInitProgress(PROGRESS.config);
			}
			printInitProgress(PROGRESS.install(pm));
			try {
				await (props.initConfig ?? defaultInitConfig)({
					cwd,
					install: true,
					packageManager: pm,
					...(planned !== undefined ? { services: planned } : {}),
				});
			} catch (error) {
				if (error instanceof ConfigInstallFailed) {
					const failed = installFailedNext(error.command);
					printInitDone(
						formatInitDone({
							heading: failed.heading,
							body: failed.body,
							rows: [],
							next: joinNext(failed.next, mcpFailedNext()),
						}),
					);
					printed = true;
					outcome = "error";
					throw error;
				}
				throw error;
			}
			funnel.config = existingConfig ? "existing" : "created";
		} else {
			funnel.config = "skipped";
		}

		const context = readContextFile(contextFile);
		const branch = contextBranch(context);
		const linked = isLinked(contextFile);
		const alreadyPulled =
			linkedNow && funnel.link === "linked" && !pinnedOffline;
		// A skipped link leaves either no pin or one the account flags asked to replace,
		// and an offline pin has no credentials to pull with.
		const shouldPull =
			funnel.link !== "skipped" &&
			!pinnedOffline &&
			shouldPullEnvAfterInitConfig({
				wroteNewFile,
				extraServices,
				alreadyPulled,
				...(typeof context.projectId === "string"
					? { projectId: context.projectId }
					: {}),
				...(branch !== undefined ? { branch } : {}),
			});

		if (shouldPull) {
			try {
				if (
					typeof context.projectId !== "string" ||
					typeof branch !== "string"
				) {
					throw new Error(
						"Env pull requires a linked project and branch.",
					);
				}
				printInitProgress(PROGRESS.env);
				await raceSigint(
					(props.envPull ?? defaultPullInitEnv)({
						...auth,
						output: props.output,
						cwd,
						projectId: context.projectId,
						branch,
					}),
				);
			} catch (error) {
				// A SIGINT during the pull raced in as InitCancelled (see raceSigint): let it
				// fall through to the outer catch's cancelled-summary handling below, same as
				// a cancellation anywhere else in this function, rather than reporting it as
				// an env-pull failure here.
				if (error instanceof InitCancelled) {
					throw error;
				}
				const failed = envPullFailedNext();
				printInitDone(
					formatInitDone({
						heading: failed.heading,
						body: failed.body,
						rows: [
							{
								label: "Agents",
								value: agentsRowValue({
									tooling: reportedTooling(),
									installed: funnel.agentsInstalled,
								}),
							},
							{
								label: "Project",
								value: projectRowValue(funnel.link),
							},
							{
								label: "Config",
								value: configRowValue(
									funnel.config,
									existingFilename,
								),
							},
						],
						next: joinNext(failed.next, mcpFailedNext()),
					}),
				);
				printed = true;
				outcome = "error";
				throw error;
			}
		}

		const pendingUnauthed = funnel.link === "skipped" && !noLink;
		const pendingServices = extraServices && linked;
		const pendingClaimable =
			funnel.link === "claimable" && claimExpiresAt !== undefined;
		const pendingExisting =
			funnel.config === "existing" && linked && !wroteNewFile;
		const pending =
			pinnedOffline ||
			pendingUnauthed ||
			pendingServices ||
			(pendingClaimable && extraServices) ||
			pendingExisting;

		const next: string[] = [];
		if (pinnedOffline) {
			const commands = deferredLinkCommands(props, linkInputs);
			next.push(
				...offlinePinNext({
					login: commands.login,
					...(extraServices ? {} : { envPull: commands.envPull }),
				}),
			);
		} else if (pendingUnauthed) {
			next.push(
				...unattendedUnauthedNext(
					hasExplicitLinkInputs
						? deferredLinkCommands(props, linkInputs)
						: undefined,
				),
			);
			const deferredMcp = mcpDeferredNext();
			if (deferredMcp.length > 0) {
				next.push("", ...deferredMcp);
			}
		} else if (noLink && !alreadyLinked) {
			next.push(...skippedLinkNext());
		}
		if (pendingClaimable && extraServices && claimExpiresAt !== undefined) {
			if (next.length > 0) {
				next.push("");
			}
			next.push(...claimableThenServicesNext(claimExpiresAt));
		} else if (pendingClaimable && claimExpiresAt !== undefined) {
			if (next.length > 0) {
				next.push("");
			}
			next.push(...claimableNext(claimExpiresAt));
		} else if (pendingServices) {
			if (next.length > 0) {
				next.push("");
			}
			next.push(...extraServicesNext());
		} else if (pendingExisting) {
			if (next.length > 0) {
				next.push("");
			}
			next.push(...existingConfigNext());
		}

		outcome =
			pending && !pendingUnauthed && noLink
				? "success"
				: pending
					? "pending"
					: "success";
		if (pendingUnauthed) {
			outcome = "pending";
		}
		if (
			noLink &&
			!pendingUnauthed &&
			!pendingServices &&
			!pendingExisting
		) {
			outcome = "success";
		}
		if (mcpState.error !== undefined) {
			outcome = "error";
		}

		printInitDone(
			formatInitDone({
				heading: headingForKind(outcome),
				rows: [
					{
						label: "Agents",
						value: agentsRowValue({
							tooling: reportedTooling(),
							installed: funnel.agentsInstalled,
						}),
					},
					{
						label: "Project",
						value: pinnedOffline
							? PROJECT_PINNED_OFFLINE
							: projectRowValue(
									funnel.link ??
										(linked ? "already_linked" : null),
								),
					},
					{
						label: "Config",
						value: configRowValue(funnel.config, existingFilename),
					},
				],
				next: joinNext(mcpFailedNext(), next),
			}),
		);
		printed = true;
		if (mcpState.error !== undefined) {
			throw mcpState.error;
		}

		takeCommandSuccessExtras();
		recordCommandSuccessExtras({
			init_kind: detection.emptyDirectory ? "empty-skip" : "existing",
			...(extrasSetup(funnel.agentSetup) !== undefined
				? { agent_setup: extrasSetup(funnel.agentSetup) }
				: {}),
		});
	} catch (error) {
		restoreCursor();
		if (error instanceof InitCancelled) {
			outcome = "aborted";
			if (!printed) {
				printInitDone(
					formatInitDone({
						heading: headingForKind("aborted"),
						body: CANCELLED_BODY,
						rows: [],
						next: [],
					}),
				);
			}
			throw error;
		}
		outcome = "error";
		throw error;
	} finally {
		finishInitFunnel(funnel, outcome, analytics);
	}
};

const uniqueAgents = (ids: readonly AgentType[]): AgentType[] => {
	const seen = new Set<AgentType>();
	const out: AgentType[] = [];
	for (const id of ids) {
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);
		out.push(id);
	}
	return out;
};

const joinNext = (
	first: readonly string[],
	second: readonly string[],
): string[] =>
	first.length === 0 || second.length === 0
		? [...first, ...second]
		: [...first, "", ...second];

const withoutMcp = (tooling: InitToolingPlan): InitToolingPlan => {
	if (tooling.setup === "mixed") {
		return { ...tooling, mcpAgents: [] };
	}
	if (tooling.setup === "skills-mcp") {
		return tooling.skillsAgents.length === 0
			? { setup: "skip" }
			: { ...tooling, mcpAgents: [] };
	}
	return tooling;
};

const agentsFromTooling = (tooling: InitToolingPlan): AgentType[] => {
	switch (tooling.setup) {
		case "skip":
			return [];
		case "plugin":
			return [...tooling.agents];
		case "skills":
			return [...tooling.agents];
		case "skills-mcp":
			return uniqueAgents([
				...tooling.skillsAgents,
				...tooling.mcpAgents,
			]);
		case "mixed":
			return uniqueAgents([
				...tooling.pluginAgents,
				...tooling.skillsAgents,
				...tooling.mcpAgents,
			]);
		default: {
			const _exhaustive: never = tooling;
			return _exhaustive;
		}
	}
};
