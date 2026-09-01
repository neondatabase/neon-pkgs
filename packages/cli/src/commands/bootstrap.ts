import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { credentialInputs } from "@neon-internals/cli-core/auth_selection";
import chalk from "chalk";
import prompts, { type InitialReturnValue } from "prompts";
import type yargs from "yargs";
import { isCi } from "../env.js";
import {
	type BootstrapTemplate,
	ensureTargetUsable,
	FALLBACK_TEMPLATES,
	fetchTemplates,
	findTemplate,
	scaffoldTemplate,
	templateIds,
} from "../init/bootstrap.js";
import { type InitRun, spawnCliChild } from "../init/child.js";
import {
	agentSetupDoneLabel,
	formatInitDone,
	printInitBanner,
	printInitDone,
	shouldPrintInitBanner,
} from "../init/chrome.js";
import {
	assertNamedAgentTooling,
	type ChildForward,
	chooseYesAgentTooling,
	type InitAgentSetup,
	initPluginAgents,
	initSkillsMcpAgents,
	postScaffoldActions,
	projectContextFile,
	resolveNamedAgents,
} from "../init/plan.js";
import { runAgentTooling, runInitSteps } from "../init/tooling.js";
import { pickAgentSetupInteractively } from "../init/wizard.js";
import { log } from "../log.js";
import type { AgentType } from "../mcp/agents.js";
import type { CommonProps } from "../types.js";
import { coerceAgentFlag } from "../utils/agent_flag.js";
import { getCliName } from "../utils/cli_name.js";
import { helpCsv, helpEpilogue } from "../utils/help_text.js";
import {
	formatInstallCommand,
	inferPackageManager,
	installArgs,
	installedPackageManagers,
	type PackageManager,
	resolvePackageManager,
	runCommand,
} from "../utils/package_manager.js";
import { writer } from "../writer.js";

type BootstrapProps = CommonProps & {
	directory?: string;
	template?: string;
	force: boolean;
	listTemplates: boolean;
	agent?: string[];
	default: boolean;
	install: boolean;
	git: boolean;
	link: boolean;
	agentSetup?: boolean;
	analytics?: boolean;
	/** Keeps re-executed children on the same account. */
	configDir?: string;
	profile?: string;
	run?: InitRun;
	pickAgentSetup?: () => Promise<InitAgentSetup>;
	hasProjectPlugins?: (cwd: string) => Promise<boolean>;
	detectProjectAgents?: (
		cwd: string,
	) => readonly AgentType[] | Promise<readonly AgentType[]>;
	detectAgent?: () => AgentType | null;
};

// The directory positional is optional: omitting it in an interactive terminal
// prompts for one. In a non-interactive context a missing directory is an error.
export const command = "bootstrap [directory]";
export const describe =
	"Scaffold a new project from a Neon starter template, then install agent tooling and link a Neon project";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 bootstrap [directory] [options]")
		.positional("directory", {
			describe:
				'Directory to scaffold into. Use "." for the current directory. Omit to be prompted.',
			type: "string",
		})
		.options({
			template: {
				describe:
					"Template to use (skips the interactive picker). Run with --list-templates to see available templates.",
				type: "string",
			},
			"list-templates": {
				alias: ["list", "ls"],
				describe:
					"List available templates and exit. --output json and --output yaml print a machine-readable catalog.",
				type: "boolean",
				default: false,
			},
			force: {
				describe:
					"Scaffold into the target directory even if it is not empty (colliding files are overwritten).",
				type: "boolean",
				default: false,
			},
			default: {
				alias: "y",
				describe:
					"Quick start: scaffold the default template (or --template), then install, git, agent tooling (project folders, else the host CLI agent; if none, pass --agent or omit --default in a terminal), and link --yes. Skips those pickers; link --yes still asks for a project unless one is already linked",
				type: "boolean",
				default: false,
			},
			install: {
				describe:
					"Install dependencies after scaffolding. In interactive mode this is offered as a prompt; use --no-install to skip without being asked.",
				type: "boolean",
				default: true,
			},
			git: {
				describe:
					"Initialize a git repository after scaffolding. In interactive mode this is offered as a prompt; use --no-git to skip without being asked.",
				type: "boolean",
				default: true,
			},
			link: {
				describe: `Run \`${getCliName()} link\` after scaffolding. Templates with neon.ts link after install so env pull works; otherwise link runs before install. In interactive mode this is offered as a prompt; use --no-link to skip without being asked.`,
				type: "boolean",
				default: true,
			},
			"agent-setup": {
				type: "boolean",
				default: true,
				describe:
					"After scaffolding, install the Neon plugin or skills and MCP. Use --no-agent-setup to skip",
			},
			agent: {
				alias: "a",
				type: "array",
				string: true,
				describe:
					"Coding agent to install into (repeatable). Forwarded to plugins, or to skills and mcp. Skips agent selection. Values listed below",
				coerce: coerceAgentFlag,
			},
		})
		.example(
			"$0 bootstrap my-app",
			"Create ./my-app from an interactively chosen template",
		)
		.example(
			"$0 bootstrap . --template hono",
			"Scaffold the Hono template into the current directory",
		)
		.example(
			"$0 bootstrap my-app --default",
			"Skip the pickers; link --yes still asks for a project unless one is already linked",
		)
		.example(
			"$0 bootstrap --list-templates --output json",
			"Print the template catalog as JSON",
		)
		.example(
			"$0 bootstrap my-app --agent cursor --agent claude-code",
			"Skip agent selection; install the plugin for those agents",
		)
		.epilogue(
			helpEpilogue(
				"--agent / -a is forwarded to plugins, or to skills and mcp, not both. It skips agent selection, including with --default.",
				helpCsv("Plugin agents", initPluginAgents()),
				helpCsv("Skills and MCP agents", initSkillsMcpAgents()),
			),
		)
		.strict();

export const handler = async (props: BootstrapProps): Promise<void> => {
	if (props.listTemplates) {
		const templates = await fetchTemplates();
		if (props.output === "json" || props.output === "yaml") {
			writer(props).end(
				templates.map((t) => ({
					id: t.id,
					title: t.title,
					description: t.description,
					services: t.services ?? [],
				})),
				{ fields: ["id", "title", "description", "services"] },
			);
			return;
		}
		for (const t of templates) {
			const services =
				t.services && t.services.length > 0
					? ` [${t.services.join(" · ")}]`
					: "";
			process.stdout.write(`${t.id} — ${t.description}${services}\n`);
		}
		return;
	}

	if (shouldPrintInitBanner(props.default)) {
		printInitBanner();
	}
	const named = resolveNamedAgents(props.agent ?? []);
	if (props.agentSetup !== false) {
		assertNamedAgentTooling(named, "bootstrap", {
			...(props.directory !== undefined && props.directory.length > 0
				? { directory: props.directory }
				: {}),
			...(props.default ? { yes: true } : {}),
		});
	}
	const templates = await resolveTemplateList(props);
	// --default is a non-interactive quick start: it fills in the template and
	// directory and runs setup without asking, so it must not fall into the
	// prompt path even on a TTY.
	const interactive =
		!props.default && Boolean(process.stdout.isTTY) && !isCi();
	const template = await resolveSelectedTemplate(
		props,
		interactive,
		templates,
	);
	const targetDir = await resolveTargetDir(props, interactive, template);
	ensureTargetUsable(targetDir, props.force);
	await scaffold(template, targetDir);
	printScaffolded(template, targetDir);
	await runPostScaffoldSteps(props, targetDir, interactive, template, named);
};

/**
 * The template list to choose from. When --template is given we try the
 * built-in fallback list first to avoid a network round-trip, only fetching the
 * remote manifest if the id isn't one of the defaults.
 */
const resolveTemplateList = async (
	props: BootstrapProps,
): Promise<BootstrapTemplate[]> =>
	props.template && findTemplate(FALLBACK_TEMPLATES, props.template)
		? FALLBACK_TEMPLATES
		: fetchTemplates();

/**
 * The picker label for a template: the title first, then the Neon services it
 * uses as a dim, italic suffix, e.g. "Hono API …  Postgres · Functions". The
 * suffix is styled with chalk.dim (and italic) only — never a foreground color —
 * so it survives the cyan/underline `prompts` paints over the focused row: dim
 * and italic reset with their own SGRs, leaving the row's color and underline
 * intact. Descriptions are intentionally omitted to keep the picker uncluttered.
 */
const formatTemplateTitle = (template: BootstrapTemplate): string => {
	if (!template.services || template.services.length === 0) {
		return template.title;
	}
	return `${template.title}  ${chalk.dim.italic(template.services.join(" · "))}`;
};

const resolveSelectedTemplate = async (
	props: BootstrapProps,
	interactive: boolean,
	templates: BootstrapTemplate[],
): Promise<BootstrapTemplate> => {
	if (props.template) {
		const template = findTemplate(templates, props.template);
		if (!template) {
			throw new Error(
				`Unknown template "${props.template}". Available templates: ${templateIds(templates)}.`,
			);
		}
		return template;
	}

	// --default with no --template falls back to the first (default) template so
	// a bare `neon bootstrap my-app --default` works end to end.
	if (props.default) {
		const fallback = templates[0];
		if (!fallback) {
			throw new Error("No templates available to scaffold from.");
		}
		return fallback;
	}

	if (!interactive) {
		throw new Error(
			`No template selected. Re-run in an interactive terminal to pick one, or pass --template <id>. Available templates: ${templateIds(templates)}.`,
		);
	}

	const { id } = await prompts({
		onState: onPromptState,
		type: "select",
		name: "id",
		message: "Which template would you like to use?",
		choices: templates.map((template) => ({
			title: formatTemplateTitle(template),
			value: template.id,
		})),
		initial: 0,
	});
	const template = findTemplate(templates, id);
	if (!template) {
		throw new Error("No template selected.");
	}
	return template;
};

const resolveTargetDir = async (
	props: BootstrapProps,
	interactive: boolean,
	template: BootstrapTemplate,
): Promise<string> => {
	let dir = props.directory;
	if (dir === undefined) {
		// --default supplies a directory (the template's name) so the quick start
		// needs nothing but a template.
		if (props.default) {
			return resolve(process.cwd(), defaultDirName(template));
		}
		if (!interactive) {
			throw new Error(
				`No target directory given. Pass one, e.g. \`${getCliName()} bootstrap my-app\` (or "." for the current directory).`,
			);
		}
		const { value } = await prompts({
			onState: onPromptState,
			type: "text",
			name: "value",
			message: "Where should we scaffold your project?",
			initial: defaultDirName(template),
			validate: (input: string) =>
				input && input.trim().length > 0
					? true
					: 'Enter a directory (use "." for the current directory).',
		});
		dir = String(value).trim();
	}
	return resolve(process.cwd(), dir === "." ? "" : dir);
};

const defaultDirName = (template: BootstrapTemplate): string =>
	template.source.subdir.split("/").pop() || template.id;

const scaffold = async (
	template: BootstrapTemplate,
	targetDir: string,
): Promise<number> => {
	log.info('Fetching template "%s" from GitHub…', template.id);
	const filesWritten = await scaffoldTemplate(template, targetDir, {
		onWarn: (message) => {
			log.warning(message);
		},
	});
	log.info("Scaffolded %d files into %s.", filesWritten, targetDir);
	return filesWritten;
};

// ----------------------------------------------------------------------------
// Post-scaffold steps (install dependencies, git init, link to a Neon project)
// ----------------------------------------------------------------------------

const runPostScaffoldSteps = async (
	props: BootstrapProps,
	targetDir: string,
	interactive: boolean,
	template: BootstrapTemplate,
	named: readonly AgentType[],
): Promise<void> => {
	const inferred = inferPackageManager(targetDir);
	const defaultPm = resolvePackageManager(targetDir);
	const neonConfig = hasNeonConfig(targetDir);

	if (props.default) {
		await runDefaultSteps(
			props,
			targetDir,
			defaultPm,
			neonConfig,
			template,
			named,
		);
		return;
	}

	if (!interactive) {
		printDoneSummary({
			heading: "Project scaffolded.",
			template,
			targetDir,
			pm: defaultPm,
			installed: false,
			installFailed: false,
			gitFailed: false,
			git: false,
			agentSetup: "skip",
			linked: false,
			skippedLinkForDeps: false,
			suggestLink: true,
			agentsRan: false,
		});
		return;
	}

	let pm: PackageManager = defaultPm;
	const wantInstall =
		props.install && (await confirm(installPrompt(inferred)));
	if (wantInstall) {
		pm = inferred ?? (await selectPackageManager());
	}

	const wantGit =
		props.git &&
		!isGitRepo(targetDir) &&
		(await confirm("Initialize a git repository?"));

	const agentSetup: InitAgentSetup =
		props.agentSetup === false
			? "skip"
			: named.length > 0
				? chooseYesAgentTooling(named).setup
				: await (props.pickAgentSetup ?? pickAgentSetupInteractively)();

	const canLink = props.link && !(neonConfig && !wantInstall);
	if (props.link && !canLink) {
		logSkippedLink(pm);
	}
	const wantLink =
		canLink &&
		(await confirm(
			`Link this project to a Neon project now? (runs ${getCliName()} link)`,
		));

	const outcome = await executePostScaffold(props, targetDir, {
		yes: false,
		lockAgentSetup: named.length === 0,
		pm,
		git: wantGit,
		agentSetup,
		install: wantInstall,
		link: wantLink,
		hasNeonConfig: neonConfig,
		named,
	});
	finishPostScaffold({
		heading: "Project scaffolded.",
		template,
		targetDir,
		pm,
		...outcome,
		suggestLink: !outcome.linked,
	});
};

const installPrompt = (inferred: PackageManager | undefined): string =>
	inferred
		? `Install dependencies with ${inferred}?`
		: "Install dependencies?";

/** `link --yes` still asks for a project unless one is already linked. */
const runDefaultSteps = async (
	props: BootstrapProps,
	targetDir: string,
	pm: PackageManager,
	neonConfig: boolean,
	template: BootstrapTemplate,
	named: readonly AgentType[],
): Promise<void> => {
	log.info(
		"Quick start (--default): skipping the template, install, git, and agent pickers. link --yes still asks for a project unless one is already linked.",
	);
	const wantGit = props.git && !isGitRepo(targetDir);
	const agentSetup: InitAgentSetup =
		props.agentSetup === false
			? "skip"
			: named.length > 0
				? chooseYesAgentTooling(named).setup
				: "skills-mcp";
	const outcome = await executePostScaffold(props, targetDir, {
		yes: true,
		lockAgentSetup: false,
		pm,
		git: wantGit,
		agentSetup,
		install: props.install,
		link: props.link,
		hasNeonConfig: neonConfig,
		named,
	});
	finishPostScaffold({
		heading: "Project scaffolded.",
		template,
		targetDir,
		pm,
		...outcome,
		suggestLink: !outcome.linked,
	});
};

const executePostScaffold = async (
	props: BootstrapProps,
	targetDir: string,
	choices: {
		yes: boolean;
		lockAgentSetup: boolean;
		pm: PackageManager;
		git: boolean;
		agentSetup: InitAgentSetup;
		install: boolean;
		link: boolean;
		hasNeonConfig: boolean;
		named: readonly AgentType[];
	},
): Promise<{
	installed: boolean;
	installFailed: boolean;
	gitFailed: boolean;
	git: boolean;
	linked: boolean;
	skippedLinkForDeps: boolean;
	agentSetup: InitAgentSetup;
	agentsRan: boolean;
}> => {
	const kids = bootstrapChildren(props, targetDir);
	let installed = false;
	let installFailed = false;
	let gitFailed = false;
	let git = false;
	let linked = false;
	let skippedLinkForDeps = false;
	let agentSetup = choices.agentSetup;
	let agentsRan = false;
	const actions = postScaffoldActions({
		git: choices.git,
		agentSetup: choices.agentSetup,
		install: choices.install,
		link: choices.link,
		hasNeonConfig: choices.hasNeonConfig,
	});
	for (const action of actions) {
		if (action === "git") {
			git = await initGitRepo(targetDir);
			if (!git) {
				gitFailed = true;
				break;
			}
			continue;
		}
		if (action === "agent") {
			agentSetup = await runAgentTooling({
				cwd: targetDir,
				yes: choices.yes,
				...(choices.lockAgentSetup
					? { agentSetup: choices.agentSetup }
					: {}),
				...kids,
				...(choices.named.length > 0 ? { agents: choices.named } : {}),
				...(props.pickAgentSetup
					? { pickAgentSetup: props.pickAgentSetup }
					: {}),
				...(props.hasProjectPlugins
					? { hasProjectPlugins: props.hasProjectPlugins }
					: {}),
				...(props.detectProjectAgents
					? { detectProjectAgents: props.detectProjectAgents }
					: {}),
				...(props.detectAgent
					? { detectAgent: props.detectAgent }
					: {}),
				command: "bootstrap",
			});
			agentsRan = true;
			continue;
		}
		if (action === "install") {
			installed = await runCommand(
				choices.pm,
				installArgs(choices.pm),
				targetDir,
			);
			if (!installed) {
				installFailed = true;
			}
			continue;
		}
		if (action !== "link") {
			const _exhaustive: never = action;
			throw new Error(`Unhandled post-scaffold action: ${_exhaustive}`);
		}
		if (choices.hasNeonConfig && !installed) {
			skippedLinkForDeps = true;
			logSkippedLink(choices.pm);
			continue;
		}
		await runInitSteps([choices.yes ? ["link", "--yes"] : ["link"]], {
			cwd: targetDir,
			...kids,
		});
		linked = true;
	}
	return {
		installed,
		installFailed,
		gitFailed,
		git,
		linked,
		skippedLinkForDeps,
		agentSetup,
		agentsRan,
	};
};

const isGitRepo = (dir: string): boolean => existsSync(join(dir, ".git"));

// Config filenames the runtime loads (mirrors @neon/config). A scaffold
// that ships one makes `neon link`'s env pull evaluate it — which needs deps.
const NEON_CONFIG_FILENAMES = ["neon.ts", "neon.mts", "neon.js", "neon.mjs"];

const hasNeonConfig = (dir: string): boolean =>
	NEON_CONFIG_FILENAMES.some((name) => existsSync(join(dir, name)));

const logSkippedLink = (pm: PackageManager): void => {
	log.info(
		`Skipping the Neon link step: \`${getCliName()} link\` reads this project's neon.ts ` +
			`to pull env vars, which needs its dependencies. Run \`${formatInstallCommand(pm)}\`, ` +
			`then \`${getCliName()} link\`.`,
	);
};

const bootstrapChildren = (
	props: BootstrapProps,
	targetDir: string,
): {
	run: InitRun;
	forward: ChildForward;
	authEnv?: NodeJS.ProcessEnv;
} => {
	const explicitKey = props.profile ? "" : credentialInputs().apiKeyFlag;
	return {
		run: props.run ?? spawnCliChild,
		forward: {
			...(props.configDir ? { configDir: props.configDir } : {}),
			...(props.profile ? { profile: props.profile } : {}),
			apiHost: props.apiHost,
			contextFile: projectContextFile(targetDir, props.contextFile),
			...(props.analytics === false ? { analytics: false } : {}),
		},
		...(explicitKey ? { authEnv: { NEON_API_KEY: explicitKey } } : {}),
	};
};

/**
 * Initialize a git repository in the scaffolded directory. Just `git init` — we
 * deliberately don't auto-commit, both to avoid failing on a machine with no
 * git identity configured and to leave the first commit to the user.
 */
const initGitRepo = async (dir: string): Promise<boolean> =>
	runCommand("git", ["init"], dir);

const confirm = async (message: string): Promise<boolean> => {
	const { value } = await prompts({
		onState: onPromptState,
		type: "confirm",
		name: "value",
		message,
		initial: true,
	});
	return value === true;
};

/**
 * Ask which package manager to install with when we couldn't infer one from the
 * invocation. Offers the managers actually installed (npm preselected); with
 * one or none installed there's nothing to choose, so it returns that one (or
 * npm) without prompting. A cancelled prompt falls back to npm.
 */
const selectPackageManager = async (): Promise<PackageManager> => {
	const installed = installedPackageManagers();
	if (installed.length <= 1) {
		return installed[0] ?? "npm";
	}
	const { pm } = await prompts({
		onState: onPromptState,
		type: "select",
		name: "pm",
		message: "Which package manager should we use?",
		choices: installed.map((manager) => ({
			title: manager,
			value: manager,
		})),
		initial: Math.max(0, installed.indexOf("npm")),
	});
	return pm ?? "npm";
};

const printScaffolded = (
	template: BootstrapTemplate,
	targetDir: string,
): void => {
	log.info(
		'Scaffolded "%s" into %s.',
		template.title,
		isCurrentDir(targetDir)
			? "the current directory"
			: displayDir(targetDir),
	);
};

const printDoneSummary = (input: {
	heading: string;
	template: BootstrapTemplate;
	targetDir: string;
	pm: PackageManager;
	installed: boolean;
	installFailed: boolean;
	gitFailed: boolean;
	git: boolean;
	agentSetup: InitAgentSetup;
	agentsRan: boolean;
	linked: boolean;
	skippedLinkForDeps: boolean;
	suggestLink: boolean;
}): void => {
	const unfinished = input.installFailed || input.gitFailed;
	const heading = unfinished ? "Setup did not finish." : input.heading;
	const deps = input.installFailed
		? "install failed"
		: input.installed
			? `installed with ${input.pm}`
			: "skipped";
	const git = input.gitFailed
		? "init failed"
		: input.git
			? "initialized"
			: "skipped";
	const project = input.linked
		? "linked"
		: input.skippedLinkForDeps
			? "skipped (needs dependencies)"
			: "not linked";
	const next: string[] = [];
	if (!isCurrentDir(input.targetDir)) {
		next.push(`cd ${displayDir(input.targetDir)}`);
	}
	if (!input.installed) {
		next.push(formatInstallCommand(input.pm));
	}
	if (input.suggestLink) {
		next.push(`${getCliName()} link`);
	}
	if (!unfinished) {
		next.push("See the README to run it.");
	}
	printInitDone(
		formatInitDone({
			heading,
			rows: [
				{ label: "Template", value: input.template.title },
				{ label: "Directory", value: displayDir(input.targetDir) },
				{ label: "Dependencies", value: deps },
				{ label: "Git", value: git },
				{
					label: "Agents",
					value: agentSetupDoneLabel({
						setup: input.agentSetup,
						ran: input.agentsRan,
					}),
				},
				{ label: "Project", value: project },
			],
			next,
		}),
	);
};

const finishPostScaffold = (
	input: Parameters<typeof printDoneSummary>[0],
): void => {
	printDoneSummary(input);
	if (input.installFailed || input.gitFailed) {
		throw new Error("Setup did not finish.");
	}
};

// ----------------------------------------------------------------------------
// Path display helpers
// ----------------------------------------------------------------------------

const isCurrentDir = (targetDir: string): boolean =>
	relative(process.cwd(), targetDir) === "";

/**
 * The path to show the user: the bare relative path for the common
 * `bootstrap my-app` case, the absolute path when the target sits outside the
 * cwd (a deep `../../..` is noise), and "." for the current directory.
 */
const displayDir = (targetDir: string): string => {
	const rel = relative(process.cwd(), targetDir);
	if (rel === "") {
		return ".";
	}
	return rel.startsWith("..") ? targetDir : rel;
};

const onPromptState = (state: {
	value: InitialReturnValue;
	aborted: boolean;
	exited: boolean;
}) => {
	if (state.aborted) {
		process.stdout.write("\x1B[?25h");
		process.stdout.write("\n");
		process.exit(1);
	}
};
