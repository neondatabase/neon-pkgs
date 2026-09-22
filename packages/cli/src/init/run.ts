import { resolve } from "node:path";
import { credentialInputs } from "@neon-internals/cli-core/auth_selection";
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
import type { BootstrapTemplate } from "./bootstrap.js";
import { InitCancelled, restoreCursor } from "./cancelled.js";
import { type InitRun, initChildEnv, spawnCliChild } from "./child.js";
import {
	configPlanFromResolution,
	INIT_CONFIG_SERVICES_CONFLICT,
	INIT_TEMPLATE_KEEPS_CONFIG,
	isBareInitServices,
	resolveInitConfigChoice,
	resolveInitTemplateChoice,
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
	CLAIMABLE_MCP_API_KEY,
	CLAIMABLE_NO_LINK,
	claimableNext,
	claimableThenServicesNext,
	envPullFailedNext,
	existingConfigNext,
	extraServicesNext,
	installFailedNext,
	NO_AGENTS_FALLBACK_STATUS,
	NON_TTY_LINK_NEEDS_AUTH,
	PROGRESS,
	skippedLinkNext,
	TEMPLATE_UNSUPPORTED_FLAGS,
	unattendedUnauthedNext,
	YES_SELECTS_RECOMMENDED,
} from "./copy.js";
import { detectInitEnvironment } from "./detect.js";
import {
	createInitFunnel,
	emitInitStart,
	finishInitFunnel,
	type InitFunnelAgentSetup,
	type InitFunnelOutcome,
	type InitFunnelState,
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
	InitMcpScopeChoice,
	InitMode,
	InitProjectSetupChoice,
} from "./mode.js";
import { resolveInitMode } from "./mode.js";
import {
	assertNamedAgentTooling,
	funnelAgentSetup,
	INIT_NEEDS_YES_OR_TERMINAL,
	type InitToolingPlan,
	planInitToolingSteps,
	recommendedTooling,
	resolveNamedAgents,
	splitInitTooling,
} from "./plan.js";
import { runInitSteps } from "./tooling.js";
import {
	pickAgentSetupInteractively,
	pickInitAgentsInteractively,
	pickInitConfigInteractively,
	pickInitMcpAuthInteractively,
	pickInitMcpPinInteractively,
	pickInitMcpScopeInteractively,
	pickInitModeInteractively,
	pickInitPackageManagerInteractively,
	pickInitProjectSetupInteractively,
	pickInitServicesInteractively,
	pickInitSkillsInteractively,
} from "./wizard.js";

export type { InitRun };
export { initChildEnv };

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
	skipTemplate?: boolean;
	template?: string;
	config?: boolean;
	services?: unknown;
	orgId?: string;
	projectId?: string;
	projectName?: string;
	regionId?: string;
	branch?: string;
	mode?: InitMode;
	agentSetup?: InitAgentSetupChoice;
	projectSetup?: InitProjectSetupChoice;
	packageManager?: PackageManager;
	mcpScope?: InitMcpScopeChoice;
	mcpAuth?: InitMcpAuthChoice;
	mcpProjectId?: string;
	mcpProjectPin?: boolean;
	run?: InitRun;
	runBootstrap?: (
		props: import("../commands/bootstrap.js").BootstrapProps,
	) => Promise<
		import("../commands/bootstrap.js").NestedBootstrapResult | undefined
	>;
	fetchTemplates?: () => Promise<BootstrapTemplate[]>;
	pickMode?: () => Promise<InitMode>;
	pickAgentSetup?: () => Promise<InitAgentSetupChoice>;
	pickAgents?: (input: {
		available: readonly AgentType[];
		detected: readonly AgentType[];
	}) => Promise<AgentType[]>;
	pickSkills?: () => Promise<string[]>;
	pickMcpScope?: () => Promise<InitMcpScopeChoice>;
	pickMcpAuth?: (input: {
		authenticated: boolean;
	}) => Promise<InitMcpAuthChoice>;
	pickMcpPin?: (input: {
		projectId: string;
		minting: boolean;
	}) => Promise<boolean>;
	pickProjectSetup?: () => Promise<InitProjectSetupChoice>;
	pickConfig?: () => Promise<boolean>;
	pickServices?: () => Promise<NeonService[]>;
	pickPackageManager?: () => Promise<PackageManager | undefined>;
	linkProject?: RunLink;
	createClaimable?: InitClaimFn;
	initConfig?: InitConfigFn;
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
	setup: InitAgentSetupChoice,
	scope: "global" | "project",
): AgentType[] => {
	if (setup === "plugin") {
		return pluginsInstallableAgents(scope);
	}
	if (setup === "skip") {
		return [];
	}
	const ids = new Set([
		...skillsInstallableAgents(),
		...mcpInstallableAgents(scope === "project" ? "project" : "global"),
	]);
	return [...ids];
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

const noteTemplateKeepsShippedConfig = (
	config: boolean | undefined,
	services: readonly string[] | undefined,
): void => {
	if (config === undefined && services === undefined) {
		return;
	}
	log.warning(INIT_TEMPLATE_KEEPS_CONFIG);
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
	const run = props.run ?? spawnCliChild;
	const explicitKey = props.profile ? "" : credentialInputs().apiKeyFlag;
	const authEnv = explicitKey ? { NEON_API_KEY: explicitKey } : undefined;
	const configDir = props.configDir ?? defaultDir;
	const forward = {
		...(props.configDir ? { configDir: props.configDir } : {}),
		...(props.profile ? { profile: props.profile } : {}),
		apiHost: props.apiHost,
		contextFile,
		...(props.analytics === false ? { analytics: false } : {}),
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
		const detection = await detectInitEnvironment({
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
		});
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

		const templateChoice = resolveInitTemplateChoice({
			empty: detection.emptyDirectory,
			yes,
			skipTemplate: props.skipTemplate === true,
			template: props.template,
		});

		if (templateChoice.kind === "template") {
			if (yes && props.mode === "custom" && props.agentSetup !== "skip") {
				throw new Error(YES_SELECTS_RECOMMENDED);
			}
			if (
				props.mode !== undefined ||
				props.projectSetup !== undefined ||
				props.packageManager !== undefined ||
				props.mcpScope !== undefined ||
				props.mcpAuth !== undefined ||
				props.mcpProjectId !== undefined ||
				props.mcpProjectPin !== undefined ||
				(props.skill !== undefined && props.skill.length > 0) ||
				(props.agentSetup !== undefined && props.agentSetup !== "skip")
			) {
				throw new Error(TEMPLATE_UNSUPPORTED_FLAGS);
			}
			await runTemplatePath({
				props,
				cwd,
				contextFile,
				yes,
				linkInputs,
				servicesFlag,
				funnel,
				templateId: templateChoice.id,
			});
			outcome = "success";
			printed = true;
			return;
		}

		const modeResolution = resolveInitMode({
			yes,
			interactive:
				detection.interactive ||
				props.pickMode !== undefined ||
				props.pickAgentSetup !== undefined,
			namedAgents: named.length > 0,
			noLink: props.link === false,
			hasLinkInputs: hasExplicitLinkInputs,
			...(props.mode !== undefined ? { mode: props.mode } : {}),
			...(props.agentSetup !== undefined
				? { agentSetup: props.agentSetup }
				: {}),
			...(props.projectSetup !== undefined
				? { projectSetup: props.projectSetup }
				: {}),
			...(props.skill !== undefined ? { skills: props.skill } : {}),
			...(props.mcpScope !== undefined
				? { mcpScope: props.mcpScope }
				: {}),
			...(props.mcpAuth !== undefined ? { mcpAuth: props.mcpAuth } : {}),
			...(props.mcpProjectId !== undefined
				? { mcpProjectId: props.mcpProjectId }
				: {}),
			...(props.mcpProjectPin !== undefined
				? { mcpProjectPin: props.mcpProjectPin }
				: {}),
			...(props.config !== undefined ? { configFlag: props.config } : {}),
			...(servicesFlag !== undefined ? { services: servicesFlag } : {}),
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

		if (props.projectSetup === "claimable") {
			if (props.link === false) {
				throw new Error(CLAIMABLE_NO_LINK);
			}
			if (hasExplicitLinkInputs) {
				throw new Error(CLAIMABLE_ACCOUNT_FLAGS);
			}
		}

		const alreadyLinked = isLinked(contextFile);
		const existingConfig = hasNeonConfigFile(cwd);
		const existingFilename = neonConfigFilename(cwd);
		const claimableExisting =
			alreadyLinked &&
			readLinkedClaimableCredentials(
				configDir,
				readContextFile(contextFile),
			) !== null;

		const recommended = mode === "recommended";
		const targets = named.length > 0 ? named : detection.detectedAgents;

		let agentSetupChoice: InitAgentSetupChoice | "skills" | "mixed" =
			props.agentSetup ?? "plugin";
		let tooling: InitToolingPlan = { setup: "skip" };
		let mcpAuth: InitMcpAuthChoice | undefined = props.mcpAuth;
		let mcpScope: InitMcpScopeChoice = props.mcpScope ?? "global";
		let selectedSkills: readonly string[] | undefined = props.skill;
		let delayMcp = false;
		let pluginScope: "global" | "project" = recommended
			? "global"
			: "project";

		if (props.agentSetup === "skip") {
			tooling = { setup: "skip" };
			agentSetupChoice = "skip";
		} else if (recommended) {
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
			if (props.agentSetup === undefined && named.length > 0) {
				tooling = splitInitTooling(
					named,
					pluginScopeFor(named, "project"),
				);
				pluginScope = pluginScopeFor(named, "project");
				agentSetupChoice = funnelAgentSetup(tooling);
			} else {
				const setup =
					props.agentSetup ??
					(await (
						props.pickAgentSetup ?? pickAgentSetupInteractively
					)());
				agentSetupChoice = setup;
				if (setup !== "skip") {
					pluginScope = pluginScopeFor(targets, "project");
					const available = availableForSetup(setup, pluginScope);
					const selected =
						named.length > 0
							? named.filter((id) => available.includes(id))
							: props.pickAgents !== undefined
								? await props.pickAgents({
										available,
										detected:
											detection.detectedAgents.filter(
												(id) => available.includes(id),
											),
									})
								: detection.interactive
									? await pickInitAgentsInteractively({
											available,
											detected:
												detection.detectedAgents.filter(
													(id) =>
														available.includes(id),
												),
										})
									: detection.detectedAgents.filter((id) =>
											available.includes(id),
										);
					if (setup === "plugin") {
						pluginScope = pluginScopeFor(selected, pluginScope);
						tooling = splitInitTooling(selected, pluginScope);
						if (
							tooling.setup !== "plugin" &&
							tooling.setup !== "skip"
						) {
							const pluginOnly = splitInitTooling(
								selected.filter((id) =>
									pluginsInstallableAgents(
										pluginScope,
									).includes(id),
								),
								pluginScope,
							);
							tooling = pluginOnly;
						}
					} else {
						if (selectedSkills === undefined) {
							selectedSkills =
								props.pickSkills !== undefined
									? await props.pickSkills()
									: detection.interactive
										? await pickInitSkillsInteractively()
										: undefined;
						}
						mcpScope =
							props.mcpScope ??
							(props.pickMcpScope !== undefined
								? await props.pickMcpScope()
								: detection.interactive
									? await pickInitMcpScopeInteractively()
									: "global");
						mcpAuth =
							props.mcpAuth ??
							(props.pickMcpAuth !== undefined
								? await props.pickMcpAuth({
										authenticated: detection.authenticated,
									})
								: detection.interactive
									? await pickInitMcpAuthInteractively({
											authenticated:
												detection.authenticated,
										})
									: detection.authenticated
										? "api-key"
										: "oauth");
						tooling = {
							setup: "skills-mcp",
							skillsAgents: selected.filter((id) =>
								skillsInstallableAgents().includes(id),
							),
							mcpAgents: selected.filter((id) =>
								mcpInstallableAgents(
									mcpScope === "project"
										? "project"
										: "global",
								).includes(id),
							),
						};
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
		delayMcp =
			usesMcp &&
			(mcpAuth === "api-key" ||
				(props.mcpProjectPin === true &&
					props.mcpProjectId === undefined));

		const mcpOauth =
			mcpAuth === "oauth" || (recommended && !detection.authenticated);
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
			mcpProject: mcpScope === "project",
			...(selectedSkills !== undefined ? { skills: selectedSkills } : {}),
			...(props.mcpProjectId !== undefined && !delayMcp
				? { mcpProjectId: props.mcpProjectId }
				: {}),
		});
		if (toolingSteps.length > 0) {
			await runInitSteps(toolingSteps, {
				cwd,
				run,
				forward,
				authEnv,
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
			if (detection.authenticated) {
				projectSetup = "link";
			} else if (detection.interactive && !yes) {
				projectSetup = "link";
			} else {
				projectSetup = "skip";
				funnel.link = "skipped";
			}
		} else if (props.projectSetup !== undefined) {
			projectSetup = props.projectSetup;
		} else if (detection.authenticated) {
			projectSetup = "link";
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
			(projectSetup === "claimable" || props.projectSetup === "claimable")
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
			let pinId = props.mcpProjectId;
			if (
				pinId === undefined &&
				props.mcpProjectPin !== false &&
				typeof linkedId === "string" &&
				linkedId.length > 0
			) {
				const pin =
					props.mcpProjectPin === true
						? true
						: detection.interactive
							? await (
									props.pickMcpPin ??
									pickInitMcpPinInteractively
								)({
									projectId: linkedId,
									minting: true,
								})
							: false;
				if (pin) {
					pinId = linkedId;
				}
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
				mcpProject: mcpScope === "project",
				...(pinId !== undefined ? { mcpProjectId: pinId } : {}),
			});
			if (mcpSteps.length > 0) {
				await runInitSteps(mcpSteps, {
					cwd,
					run,
					forward,
					authEnv,
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
				await runInitSteps([["env", "pull"]], {
					cwd,
					run,
					forward,
					authEnv,
					narrate: "human",
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

const nestedBootstrapDirectory = (cwd: string): string =>
	resolve(cwd) === resolve(process.cwd()) ? "." : cwd;

const runTemplatePath = async (input: {
	props: InitProps;
	cwd: string;
	contextFile: string;
	yes: boolean;
	linkInputs: InitLinkInputs;
	servicesFlag: readonly string[] | undefined;
	funnel: InitFunnelState;
	templateId: string;
}): Promise<void> => {
	const { props, cwd, contextFile, yes, linkInputs, servicesFlag, funnel } =
		input;
	if (!yes && props.runBootstrap === undefined && !props.fetchTemplates) {
		const { canPickAgentsInteractively } = await import(
			"../utils/agent_picker.js"
		);
		if (!canPickAgentsInteractively()) {
			throw new Error(INIT_NEEDS_YES_OR_TERMINAL);
		}
	}
	noteTemplateKeepsShippedConfig(props.config, servicesFlag);
	const { handler: bootstrapHandler } = await import(
		"../commands/bootstrap.js"
	);
	const runBootstrap = props.runBootstrap ?? bootstrapHandler;
	const result = await runBootstrap({
		apiClient: props.apiClient,
		apiKey: props.apiKey,
		apiHost: props.apiHost,
		output: props.output,
		contextFile,
		directory: nestedBootstrapDirectory(cwd),
		force: false,
		listTemplates: false,
		default: yes,
		install: true,
		git: true,
		link: props.link !== false,
		printBanner: false,
		skipDoneSummary: true,
		linkNoConfig: true,
		narrate: "human",
		template: input.templateId,
		linkInputs,
		...(props.agent !== undefined ? { agent: props.agent } : {}),
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
		...(props.analytics === false ? { analytics: false } : {}),
		...(props.run ? { run: props.run } : {}),
		...(props.linkProject ? { linkProject: props.linkProject } : {}),
		...(props.pickAgentSetup
			? { pickAgentSetup: props.pickAgentSetup }
			: {}),
		...(props.agentSetup === "skip" ? { agentSetup: false } : {}),
		...(props.detectProjectAgents
			? { detectProjectAgents: props.detectProjectAgents }
			: {}),
		...(props.detectAgent ? { detectAgent: props.detectAgent } : {}),
		...(props.hasProjectPlugins
			? { hasProjectPlugins: props.hasProjectPlugins }
			: {}),
	});
	funnel.mode = "custom";
	funnel.agentSetup = result?.agentSetup ?? "skip";
	funnel.link = result?.linked === true ? "linked" : "skipped";
	funnel.config =
		result?.hasNeonConfig === true || hasNeonConfigFile(cwd)
			? "created"
			: "skipped";
	printInitDone(
		formatInitDone({
			heading: headingForKind("success"),
			rows: [
				{
					label: "Template",
					value: result?.templateTitle ?? input.templateId,
				},
				{
					label: "Agents",
					value: agentsRowValue({
						setup: funnel.agentSetup,
						agents: [],
					}),
				},
				{
					label: "Project",
					value: projectRowValue(funnel.link),
				},
				{
					label: "Config",
					value: "provided by template",
				},
			],
			next: [],
		}),
	);
	takeCommandSuccessExtras();
	recordCommandSuccessExtras({
		init_kind: "empty-template",
		...(result?.agentSetup !== undefined
			? { agent_setup: result.agentSetup }
			: {}),
	});
};
