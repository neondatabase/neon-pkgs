import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { credentialInputs } from "@neon-internals/cli-core/auth_selection";
import type yargs from "yargs";
import {
	CONFIG_INIT_NONE_MEANS,
	CONFIG_INIT_SERVICES,
	CONFIG_INIT_UNAVAILABLE,
} from "../config_template.js";
import { contextBranch, readContextFile } from "../context.js";
import { type BootstrapTemplate, fetchTemplates } from "../init/bootstrap.js";
import { type InitRun, initChildEnv, spawnCliChild } from "../init/child.js";
import {
	configPlanFromResolution,
	INIT_CONFIG_SERVICES_CONFLICT,
	INIT_TEMPLATE_KEEPS_CONFIG,
	type InitConfigPlan,
	resolveInitConfigChoice,
	resolveInitTemplateChoice,
	shouldRefreshEnvAfterNewConfig,
} from "../init/choices.js";
import {
	agentSetupLabel,
	configSummaryLabel,
	formatInitDone,
	type InitConfigSummary,
	printInitBanner,
	printInitDone,
	shouldPrintInitBanner,
} from "../init/chrome.js";
import {
	type InitLinkInputs,
	type InitLinkProps,
	type RunLink,
	runAuthenticatedLink,
} from "../init/link.js";
import {
	assertNamedAgentTooling,
	directoryIsEmpty,
	INIT_NEEDS_YES_OR_TERMINAL,
	type InitAgentSetup,
	initPluginAgents,
	initSkillsMcpAgents,
	planExistingInit,
	resolveNamedAgents,
} from "../init/plan.js";
import { runAgentTooling, runInitSteps } from "../init/tooling.js";
import {
	type InitTemplatePick,
	pickInitConfigInteractively,
	pickInitLinkInteractively,
	pickInitTemplateInteractively,
} from "../init/wizard.js";
import { log } from "../log.js";
import type { AgentType } from "../mcp/agents.js";
import {
	deprecatedServiceMessage,
	parseServices,
	servicesFlagValue,
	servicesOption,
} from "../neon_services.js";
import type { CommonProps } from "../types.js";
import { coerceAgentFlag } from "../utils/agent_flag.js";
import { canPickAgentsInteractively } from "../utils/agent_picker.js";
import { getCliName } from "../utils/cli_name.js";
import { helpCsv, helpEpilogue } from "../utils/help_text.js";
import {
	type BootstrapProps,
	handler as bootstrapHandler,
	type NestedBootstrapResult,
} from "./bootstrap.js";
import { hasNeonConfigFile } from "./config.js";

export type { InitRun };
export { initChildEnv };

export type InitProps = CommonProps & {
	yes?: boolean;
	agent?: string[];
	configDir?: string;
	profile?: string;
	oauthHost?: string;
	clientId?: string;
	forceAuth?: boolean;
	allowUnsafeTls?: boolean;
	analytics?: boolean;
	data?: string;
	cwd?: string;
	skipTemplate?: boolean;
	template?: string;
	config?: boolean;
	services?: unknown;
	orgId?: string;
	projectId?: string;
	projectName?: string;
	regionId?: string;
	branch?: string;
	run?: InitRun;
	runBootstrap?: (
		props: BootstrapProps,
	) => Promise<NestedBootstrapResult | undefined>;
	fetchTemplates?: () => Promise<BootstrapTemplate[]>;
	pickAgentSetup?: () => Promise<InitAgentSetup>;
	pickTemplate?: (
		templates: readonly BootstrapTemplate[],
	) => Promise<InitTemplatePick>;
	pickConfig?: () => Promise<boolean>;
	pickLink?: () => Promise<boolean>;
	linkProject?: RunLink;
	detectProjectAgents?: (
		cwd: string,
	) => readonly AgentType[] | Promise<readonly AgentType[]>;
	detectAgent?: () => AgentType | null;
	hasProjectPlugins?: (cwd: string) => Promise<boolean>;
};

export const command = "init";
export const describe =
	"Set up this directory for Neon: agent tooling, a linked project, and optionally neon.ts. In an empty directory, pick a template or skip scaffolding.";

const removedProtocol = () =>
	`\`${getCliName()} init --data\` was removed. Run \`${getCliName()} init\` or \`${getCliName()} init -y\`.`;

export const builder = (yargs: yargs.Argv) =>
	yargs
		.usage("$0 init [options]")
		.option("context-file", {
			hidden: true,
		})
		.option("yes", {
			alias: "y",
			type: "boolean",
			default: false,
			describe:
				"Empty dir: scaffold the default template. --skip-template: plugin, or skills and MCP, for project folders, else the host CLI agent. Exits if none. Then link with defaults and create the bare neon.ts policy. Project selection may still be required",
		})
		.option("skip-template", {
			type: "boolean",
			default: false,
			describe:
				"Do not scaffold a template. Set up agents, link a project, and optionally neon.ts in this directory",
		})
		.option("template", {
			type: "string",
			describe:
				"Template to scaffold into an empty directory. Conflicts with --skip-template",
		})
		.option("config", {
			type: "boolean",
			describe:
				"Existing app or --skip-template: create neon.ts after linking. Use --no-config to skip. Omitted in a terminal: you will be asked. Scaffolding a template keeps that template's neon.ts",
		})
		.option(
			"services",
			servicesOption({
				key: "services",
				allowed: CONFIG_INIT_SERVICES,
				describe:
					"Existing app or --skip-template: services to declare in neon.ts",
				noneMeans: CONFIG_INIT_NONE_MEANS,
				also: "Implies creating neon.ts. Cannot be combined with --no-config. Ignored when scaffolding a template.",
			}),
		)
		.option("org-id", {
			describe: "Forwarded to link: organization ID to link to",
			type: "string",
		})
		.option("project-id", {
			describe: "Forwarded to link: existing project ID to link to",
			type: "string",
		})
		.option("project-name", {
			describe: "Forwarded to link: name for a new project",
			type: "string",
		})
		.option("region-id", {
			describe: "Forwarded to link: region for a new project",
			type: "string",
		})
		.option("branch", {
			alias: "branch-id",
			describe: "Forwarded to link: branch name or ID to pin",
			type: "string",
		})
		.option("agent", {
			alias: "a",
			type: "array",
			string: true,
			describe:
				"Coding agent to install into (repeatable). Forwarded to plugins, or to skills and mcp. Skips agent selection. Values listed below",
			coerce: coerceAgentFlag,
		})
		.option("data", {
			hidden: true,
			type: "string",
		})
		.option("output", {
			alias: "o",
			hidden: true,
			describe:
				"Not supported; the commands init runs print their own output",
		})
		.example("$0 init", "Set up this directory (template picker if empty)")
		.example(
			"$0 init --skip-template",
			"Empty dir: agents, link, and neon.ts — no template files",
		)
		.example("$0 init -y", "Default template, or existing-app defaults")
		.example(
			"$0 init --agent cursor --agent claude-code",
			"Skip agent selection; install the plugin for those agents",
		)
		.epilogue(
			helpEpilogue(
				"Empty directory: pick a starter template, or skip scaffolding and only set up agents, a Neon project, and neon.ts. That skip is not on `neon bootstrap`.",
				"Interactive agent setup: plugin (recommended), skills and MCP separately, or skip agent setup. Never both plugin and skills+MCP.",
				"neon.ts is optional when you skip the template or set up an existing app. Saying no skips the services picker and does not write the file. Scaffolding a template keeps that template's neon.ts.",
				"-y installs the plugin when Cursor, Claude Code, or Codex is in project folders, else the host CLI agent. Otherwise skills and MCP. If none are found, it exits: pass --agent <name>, run from a supported agent, or omit -y in a terminal to pick. Then link unless already linked. Project selection may still be required.",
				"--agent / -a is forwarded to plugins, or to skills and mcp, not both. It skips agent selection, including with -y.",
				helpCsv("Plugin agents", initPluginAgents()),
				helpCsv("Skills and MCP agents", initSkillsMcpAgents()),
			),
		)
		.check((argv) => {
			if (argv.data !== undefined) {
				throw new Error(removedProtocol());
			}
			if (
				argv.help !== true &&
				(argv.output === "json" || argv.output === "yaml")
			) {
				throw new Error(
					`\`${getCliName()} init\` does not support --output. The commands it runs print their own output.`,
				);
			}
			return true;
		})
		.strict();

const isLinked = (contextFile: string): boolean => {
	const projectId = readContextFile(contextFile).projectId;
	return typeof projectId === "string" && projectId.length > 0;
};

const nestedBootstrapDirectory = (cwd: string): string =>
	resolve(cwd) === resolve(process.cwd()) ? "." : cwd;

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

const nestedBootstrapProps = (
	props: InitProps,
	cwd: string,
	contextFile: string,
	template: {
		id?: string;
		selected?: BootstrapTemplate;
		useDefault: boolean;
	},
	linkInputs: InitLinkInputs,
): BootstrapProps => ({
	apiClient: props.apiClient,
	apiKey: props.apiKey,
	apiHost: props.apiHost,
	output: props.output,
	contextFile,
	directory: nestedBootstrapDirectory(cwd),
	force: false,
	listTemplates: false,
	default: template.useDefault,
	install: true,
	git: true,
	link: true,
	printBanner: false,
	skipDoneSummary: true,
	linkNoConfig: true,
	narrate: "human",
	...(template.selected ? { selectedTemplate: template.selected } : {}),
	...(!template.selected && template.id !== undefined
		? { template: template.id }
		: {}),
	linkInputs,
	...(props.agent !== undefined ? { agent: props.agent } : {}),
	...(props.configDir ? { configDir: props.configDir } : {}),
	...(props.profile ? { profile: props.profile } : {}),
	...(props.oauthHost ? { oauthHost: props.oauthHost } : {}),
	...(props.clientId ? { clientId: props.clientId } : {}),
	...(props.forceAuth !== undefined ? { forceAuth: props.forceAuth } : {}),
	...(props.allowUnsafeTls !== undefined
		? { allowUnsafeTls: props.allowUnsafeTls }
		: {}),
	...(props.analytics === false ? { analytics: false } : {}),
	...(props.run ? { run: props.run } : {}),
	...(props.linkProject ? { linkProject: props.linkProject } : {}),
	...(props.pickLink ? { pickLink: props.pickLink } : {}),
	...(props.pickAgentSetup ? { pickAgentSetup: props.pickAgentSetup } : {}),
	...(props.detectProjectAgents
		? { detectProjectAgents: props.detectProjectAgents }
		: {}),
	...(props.detectAgent ? { detectAgent: props.detectAgent } : {}),
	...(props.hasProjectPlugins
		? { hasProjectPlugins: props.hasProjectPlugins }
		: {}),
});

const projectRow = (input: {
	alreadyLinked: boolean;
	linkedNow: boolean;
}): string => {
	if (input.alreadyLinked) {
		return "already linked";
	}
	if (input.linkedNow) {
		return "linked";
	}
	return "not linked";
};

const configSummary = (input: {
	plan: InitConfigPlan;
	existingConfig: boolean;
}): InitConfigSummary => {
	if (input.plan.kind === "skip") {
		return "skipped";
	}
	if (input.existingConfig) {
		return "existing";
	}
	return "created";
};

const printNestedBootstrapDone = (
	result: NestedBootstrapResult | undefined,
	cwd: string,
	fallbackTitle: string,
): void => {
	const hasConfig = result?.hasNeonConfig === true || hasNeonConfigFile(cwd);
	printInitDone(
		formatInitDone({
			heading: "Neon setup complete.",
			rows: [
				{
					label: "Template",
					value: result?.templateTitle ?? fallbackTitle,
				},
				{
					label: "Agents",
					value: agentSetupLabel(result?.agentSetup ?? "skip"),
				},
				{
					label: "Project",
					value: projectRow({
						alreadyLinked: false,
						linkedNow: result?.linked === true,
					}),
				},
				{
					label: "Config",
					value: configSummaryLabel(
						hasConfig ? "template" : "skipped",
					),
				},
			],
			next: [],
		}),
	);
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

export const handler = async (props: InitProps) => {
	if (props.output === "json" || props.output === "yaml") {
		throw new Error(
			`\`${getCliName()} init\` does not support --output. The commands it runs print their own output.`,
		);
	}

	const cwd = props.cwd ?? process.cwd();
	const names = existsSync(cwd) ? readdirSync(cwd) : [];
	const contextFile = resolve(cwd, props.contextFile);
	const yes = props.yes === true;
	const named = resolveNamedAgents(props.agent ?? []);
	assertNamedAgentTooling(named, "init", yes ? { yes: true } : undefined);
	const run = props.run ?? spawnCliChild;
	const explicitKey = props.profile ? "" : credentialInputs().apiKeyFlag;
	const authEnv = explicitKey ? { NEON_API_KEY: explicitKey } : undefined;
	const forward = {
		...(props.configDir ? { configDir: props.configDir } : {}),
		...(props.profile ? { profile: props.profile } : {}),
		apiHost: props.apiHost,
		contextFile,
		...(props.analytics === false ? { analytics: false } : {}),
	};
	const services = parsedInitServices(props.services);
	if (props.config === false && services !== undefined) {
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
	const templateChoice = resolveInitTemplateChoice({
		empty: directoryIsEmpty(names),
		yes,
		skipTemplate: props.skipTemplate === true,
		template: props.template,
	});

	if (shouldPrintInitBanner(yes)) {
		printInitBanner();
	}

	if (
		templateChoice.kind === "default" ||
		templateChoice.kind === "template"
	) {
		if (
			templateChoice.kind === "template" &&
			!yes &&
			props.runBootstrap === undefined &&
			!canPickAgentsInteractively()
		) {
			throw new Error(INIT_NEEDS_YES_OR_TERMINAL);
		}
		const runBootstrap = props.runBootstrap ?? bootstrapHandler;
		noteTemplateKeepsShippedConfig(props.config, services);
		const result = await runBootstrap(
			nestedBootstrapProps(
				props,
				cwd,
				contextFile,
				{
					useDefault: yes,
					...(templateChoice.kind === "template"
						? { id: templateChoice.id }
						: {}),
				},
				linkInputs,
			),
		);
		printNestedBootstrapDone(
			result,
			cwd,
			templateChoice.kind === "template" ? templateChoice.id : "default",
		);
		return;
	}

	if (templateChoice.kind === "ask") {
		if (props.pickTemplate === undefined && !canPickAgentsInteractively()) {
			throw new Error(INIT_NEEDS_YES_OR_TERMINAL);
		}
		const templates = await (props.fetchTemplates ?? fetchTemplates)();
		const picked = await (
			props.pickTemplate ?? pickInitTemplateInteractively
		)(templates);
		if (picked.kind === "template") {
			const runBootstrap = props.runBootstrap ?? bootstrapHandler;
			noteTemplateKeepsShippedConfig(props.config, services);
			const result = await runBootstrap(
				nestedBootstrapProps(
					props,
					cwd,
					contextFile,
					{ selected: picked.template, useDefault: false },
					linkInputs,
				),
			);
			printNestedBootstrapDone(result, cwd, picked.template.id);
			return;
		}
	}

	const alreadyLinked = isLinked(contextFile);
	const shouldLink = !alreadyLinked || hasExplicitLinkInputs;
	const existingConfig = hasNeonConfigFile(cwd);
	const canAskConfig =
		props.pickConfig !== undefined || canPickAgentsInteractively();

	const agentSetup = await runAgentTooling({
		cwd,
		yes,
		run,
		forward,
		authEnv,
		narrate: "human",
		command: "init",
		...(named.length > 0 ? { agents: named } : {}),
		...(props.pickAgentSetup
			? { pickAgentSetup: props.pickAgentSetup }
			: {}),
		...(props.detectProjectAgents
			? { detectProjectAgents: props.detectProjectAgents }
			: {}),
		...(props.detectAgent ? { detectAgent: props.detectAgent } : {}),
		...(props.hasProjectPlugins
			? { hasProjectPlugins: props.hasProjectPlugins }
			: {}),
	});

	const canAskLink =
		props.pickLink !== undefined || canPickAgentsInteractively();
	const acceptedLink =
		shouldLink &&
		(yes ||
			!canAskLink ||
			(await (props.pickLink ?? pickInitLinkInteractively)()));
	if (acceptedLink) {
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
	}

	const configResolution = resolveInitConfigChoice({
		flag: props.config,
		yes,
		canAsk: canAskConfig,
		existingConfig,
		...(services !== undefined ? { services } : {}),
	});
	const accepted =
		configResolution.kind === "ask"
			? await (props.pickConfig ?? pickInitConfigInteractively)()
			: undefined;
	const configPlan = configPlanFromResolution(configResolution, accepted);

	if (configPlan.kind === "write") {
		await runInitSteps(
			planExistingInit({
				linked: true,
				yes,
				agentSetup: "skip",
				config: configPlan,
			}),
			{ cwd, run, forward, authEnv, narrate: "human" },
		);
		const context = readContextFile(contextFile);
		const branch = contextBranch(context);
		if (
			shouldRefreshEnvAfterNewConfig({
				wroteNewFile: !existingConfig,
				projectId: context.projectId,
				branch,
			})
		) {
			try {
				await runInitSteps([["env", "pull"]], {
					cwd,
					run,
					forward,
					authEnv,
					narrate: "human",
				});
			} catch (err) {
				const message =
					err instanceof Error ? err.message : String(err);
				log.warning(
					"Created neon.ts, but pulling its Neon env vars failed: %s\n" +
						`Run \`${getCliName()} env pull\` once resolved.`,
					message,
				);
			}
		}
	}

	printInitDone(
		formatInitDone({
			heading: "Neon setup complete.",
			rows: [
				{ label: "Agents", value: agentSetupLabel(agentSetup) },
				{
					label: "Project",
					value: projectRow({
						alreadyLinked,
						linkedNow: acceptedLink,
					}),
				},
				{
					label: "Config",
					value: configSummaryLabel(
						configSummary({ plan: configPlan, existingConfig }),
					),
				},
			],
			next: [],
		}),
	);
};
