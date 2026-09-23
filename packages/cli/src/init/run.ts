import { resolve } from "node:path";
import {
	type CommandAgentSetup,
	recordCommandSuccessExtras,
	takeCommandSuccessExtras,
} from "../analytics.js";
import { DEFAULT_CLAIMABLE_ORIGIN } from "../claimable/api.js";
import { readLinkedClaimableCredentials } from "../claimable/state.js";
import { create as createClaimableProject } from "../commands/claim.js";
import {
	ConfigInstallFailed,
	hasNeonConfigFile,
	initCmd,
	neonConfigFilename,
} from "../commands/config.js";
import type { EnvPullProps, PullOutcome } from "../commands/env.js";
import { defaultDir } from "../config.js";
import {
	CONFIG_INIT_NONE_MEANS,
	CONFIG_INIT_SERVICES,
	CONFIG_INIT_UNAVAILABLE,
} from "../config_template.js";
import { contextBranch, readContextFile } from "../context.js";
import { log } from "../log.js";
import type { AgentType } from "../mcp/agents.js";
import { mcpInstallableAgents } from "../mcp/targets.js";
import {
	deprecatedServiceMessage,
	type NeonService,
	parseServices,
	servicesFlagValue,
} from "../neon_services.js";
import { pluginsInstallableAgents } from "../plugins/targets.js";
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
import { InitCancelled, restoreCursor } from "./cancelled.js";
import {
	configPlanFromResolution,
	INIT_CONFIG_SERVICES_CONFLICT,
	isBareInitServices,
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
	MCP_SCOPED_NEEDS_PROJECT,
	mcpConfigLocationSkipped,
	mcpConfigLocationUnavailable,
	NO_AGENTS_FALLBACK_STATUS,
	NON_TTY_LINK_NEEDS_AUTH,
	namedAgentsUnavailable,
	PROGRESS,
	skippedLinkNext,
	unattendedUnauthedNext,
	YES_LINK_NEEDS_AUTH,
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
	}) => Promise<AgentType[]>;
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

const parsedInitServices = (raw: unknown): readonly string[] | undefined => {
	const values = servicesFlagValue(raw);
	if (values === undefined) {
		return undefined;
	}
	return parseServices(values, {
		allowed: CONFIG_INIT_SERVICES,
		whyUnavailable: CONFIG_INIT_UNAVAILABLE,
		flag: "--services",
		noneMeans: CONFIG_INIT_NONE_MEANS,
		onDeprecated: (used, canonical) =>
			log.warning(deprecatedServiceMessage(used, canonical)),
	});
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

const availableForSetup = (
	setup: InitAgentSetupChoice | "skills",
	scope: "global" | "project",
): AgentType[] => {
	if (setup === "plugin") {
		return pluginsInstallableAgents(scope);
	}
	if (setup === "skip") {
		return [];
	}
	if (setup === "skills") {
		return [...skillsInstallableAgents()];
	}
	const ids = new Set([
		...skillsInstallableAgents(),
		...mcpInstallableAgents(scope === "project" ? "project" : "global"),
	]);
	return [...ids];
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
	ids: readonly AgentType[],
	scope: "global" | "project",
	fallback: boolean,
): InitToolingPlan => {
	const mcpConfigLocation = scope === "project" ? "project" : "global";
	let selected = ids;
	if (selected.length === 0 && fallback) {
		selected = FALLBACK_SKILLS_AGENTS;
	}
	return {
		setup: "skills-mcp",
		skillsAgents: selected.filter((id) =>
			skillsInstallableAgents().includes(id),
		),
		mcpAgents: selected.filter((id) =>
			mcpInstallableAgents(mcpConfigLocation).includes(id),
		),
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
	interactive: boolean;
}): Promise<AgentType[]> => {
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
	if (input.pickAgents !== undefined) {
		return input.pickAgents({
			available: [...input.available],
			detected,
		});
	}
	if (input.interactive) {
		return pickInitAgentsInteractively({
			available: [...input.available],
			detected,
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
	const servicesFlag = parsedInitServices(props.services);
	if (props.config === false && servicesFlag !== undefined) {
		throw new Error(INIT_CONFIG_SERVICES_CONFLICT);
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

		let agentSetupChoice: InitAgentSetupChoice | "skills" | "mixed" =
			"plugin";
		let tooling: InitToolingPlan = { setup: "skip" };
		let mcpAuth: InitMcpAuthChoice | undefined = props.mcpAuth;
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
					? splitInitTooling(named, "global")
					: recommendedTooling(detection.detectedAgents);
			if (named.length === 0 && detection.detectedAgents.length === 0) {
				printInitProgress(NO_AGENTS_FALLBACK_STATUS);
			}
			agentSetupChoice = funnelAgentSetup(tooling);
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
				agentSetupChoice = "skip";
			} else if (inferred.kind === "auto") {
				const autoAgents =
					named.length > 0 ? named : detection.detectedAgents;
				pluginScope = pluginScopeFor(autoAgents, "project");
				tooling = splitInitTooling(
					autoAgents,
					pluginScope,
					mcpConfigLocation,
				);
				if (tooling.setup === "skip" && yes && named.length === 0) {
					tooling = recommendedTooling([]);
					printInitProgress(NO_AGENTS_FALLBACK_STATUS);
				}
				agentSetupChoice = funnelAgentSetup(tooling);
			} else {
				const setup: InitAgentSetupChoice | "skills" =
					inferred.kind === "ask"
						? await (
								props.pickAgentSetup ??
								pickAgentSetupInteractively
							)()
						: inferred.kind;
				agentSetupChoice = setup === "skills" ? "skills" : setup;
				if (setup !== "skip") {
					pluginScope = pluginScopeFor(targets, "project");
					const available =
						setup === "plugin"
							? uniqueAgents([
									...pluginsInstallableAgents("project"),
									...pluginsInstallableAgents("global"),
								])
							: availableForSetup(setup, pluginScope);
					const selected = await pickOrDetectAgents({
						named,
						available,
						detected: detection.detectedAgents,
						interactive: detection.interactive,
						...(props.pickAgents !== undefined
							? { pickAgents: props.pickAgents }
							: {}),
					});
					const namedFallback = named.length === 0;
					if (setup === "plugin") {
						pluginScope = pluginScopeFor(selected, pluginScope);
						tooling = splitInitTooling(selected, pluginScope);
						if (
							tooling.setup !== "plugin" &&
							tooling.setup !== "skip"
						) {
							tooling = splitInitTooling(
								selected.filter((id) =>
									pluginsInstallableAgents(
										pluginScope,
									).includes(id),
								),
								pluginScope,
							);
						}
						agentSetupChoice = funnelAgentSetup(tooling);
					} else if (setup === "skills") {
						tooling = skillsTooling(selected, namedFallback);
						agentSetupChoice = funnelAgentSetup(tooling);
					} else {
						if (
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
						mcpConfigLocation =
							props.mcpConfigLocation ??
							(yes
								? "global"
								: props.pickMcpConfigLocation !== undefined
									? await props.pickMcpConfigLocation()
									: detection.interactive
										? await pickInitMcpConfigLocationInteractively()
										: "global");
						mcpAuth =
							props.mcpAuth ??
							(yes
								? detection.authenticated &&
									props.claimable !== true
									? "api-key"
									: "oauth"
								: props.pickMcpAuth !== undefined
									? await props.pickMcpAuth({
											authenticated:
												detection.authenticated,
										})
									: detection.interactive
										? await pickInitMcpAuthInteractively({
												authenticated:
													detection.authenticated,
											})
										: detection.authenticated &&
												props.claimable !== true
											? "api-key"
											: "oauth");
						validateMcpConfigLocationSupport(
							selected,
							mcpConfigLocation,
						);
						tooling = skillsMcpTooling(
							selected,
							mcpConfigLocation,
							namedFallback,
						);
						agentSetupChoice = "skills-mcp";
					}
				}
			}
		}

		funnel.agentSetup =
			agentSetupChoice === "plugin" ||
			agentSetupChoice === "skills-mcp" ||
			agentSetupChoice === "skills" ||
			agentSetupChoice === "mixed" ||
			agentSetupChoice === "skip"
				? agentSetupChoice
				: funnelAgentSetup(tooling);

		const usesMcp =
			tooling.setup === "skills-mcp" || tooling.setup === "mixed";
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
		const earlyTooling = delayMcp
			? tooling.setup === "skills-mcp"
				? {
						setup: "skills-mcp" as const,
						skillsAgents: tooling.skillsAgents,
						mcpAgents: [] as const,
					}
				: tooling.setup === "mixed"
					? {
							setup: "mixed" as const,
							pluginAgents: tooling.pluginAgents,
							skillsAgents: tooling.skillsAgents,
							mcpAgents: [] as const,
						}
					: tooling
			: tooling;

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
			await runToolingSteps(toolingSteps, {
				cwd,
				output: props.output,
				auth,
				operations: props.operations,
				narrate: "human",
			});
			funnel.agentsInstalled = agentsFromTooling(earlyTooling);
		}

		let projectSetup: InitProjectSetupChoice | "skip" | "already" = "skip";
		let linkedNow = false;
		let claimExpiresAt: string | undefined;
		const noLink = props.link === false;

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
			if (hasExplicitLinkInputs || detection.authenticated) {
				projectSetup = "link";
			} else if (detection.interactive && !yes) {
				projectSetup = "link";
			} else {
				projectSetup = "skip";
				funnel.link = "skipped";
			}
		} else if (props.claimable === true) {
			projectSetup = "claimable";
		} else if (hasExplicitLinkInputs || detection.authenticated) {
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

		if (
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
			if (yes && !detection.authenticated) {
				throw new Error(YES_LINK_NEEDS_AUTH);
			}
			printInitProgress(
				detection.authenticated ? PROGRESS.link : PROGRESS.auth,
			);
			const linkProject = props.linkProject ?? runAuthenticatedLink;
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
			await linkProject(linkProps);
			linkedNow = true;
			funnel.link = "linked";
		}

		if (delayMcp && tooling.setup !== "skip") {
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
			if (mcpSteps.length > 0) {
				await runToolingSteps(mcpSteps, {
					cwd,
					output: props.output,
					auth,
					operations: props.operations,
					narrate: "human",
				});
				funnel.agentsInstalled = uniqueAgents([
					...funnel.agentsInstalled,
					...agentsFromTooling(mcpOnly),
				]);
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
				services: picked.length === 0 ? ["none"] : picked,
			};
		}

		if (recommended && configPlan.kind === "write" && !existingConfig) {
			configPlan = {
				kind: "write",
				services: servicesFlag ?? ["none"],
			};
		}

		let wroteNewFile = false;
		let extraServices = false;
		let selectedServices: NeonService[] | null = null;
		if (configPlan.kind === "write") {
			const planned = existingConfig
				? undefined
				: (configPlan.services ?? ["none"]);
			if (planned !== undefined) {
				extraServices = !isBareInitServices(planned);
				selectedServices = extraServices
					? expandTelemetryServices(
							parseServices(planned, {
								allowed: CONFIG_INIT_SERVICES,
								flag: "--services",
								noneMeans: CONFIG_INIT_NONE_MEANS,
							}),
						)
					: [];
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
							next: failed.next,
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
		const alreadyPulled = linkedNow && funnel.link === "linked";
		const shouldPull = shouldPullEnvAfterInitConfig({
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
				await (props.envPull ?? defaultPullInitEnv)({
					...auth,
					output: props.output,
					cwd,
					projectId: context.projectId,
					branch,
				});
			} catch (error) {
				const failed = envPullFailedNext();
				printInitDone(
					formatInitDone({
						heading: failed.heading,
						body: failed.body,
						rows: [
							{
								label: "Agents",
								value: agentsRowValue({
									setup: funnel.agentSetup,
									agents: funnel.agentsInstalled,
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
						next: failed.next,
					}),
				);
				printed = true;
				outcome = "error";
				throw error;
			}
		}

		const pendingUnauthed =
			funnel.link === "skipped" && !noLink && !alreadyLinked;
		const pendingServices = extraServices && linked;
		const pendingClaimable =
			funnel.link === "claimable" && claimExpiresAt !== undefined;
		const pendingExisting =
			funnel.config === "existing" && linked && !wroteNewFile;
		const pending =
			pendingUnauthed ||
			pendingServices ||
			(pendingClaimable && extraServices) ||
			pendingExisting;

		const next: string[] = [];
		if (pendingUnauthed) {
			next.push(...unattendedUnauthedNext());
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

		printInitDone(
			formatInitDone({
				heading: headingForKind(outcome),
				rows: [
					{
						label: "Agents",
						value: agentsRowValue({
							setup: funnel.agentSetup,
							agents: funnel.agentsInstalled,
						}),
					},
					{
						label: "Project",
						value: projectRowValue(
							funnel.link ?? (linked ? "already_linked" : null),
						),
					},
					{
						label: "Config",
						value: configRowValue(funnel.config, existingFilename),
					},
				],
				next,
			}),
		);
		printed = true;

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
