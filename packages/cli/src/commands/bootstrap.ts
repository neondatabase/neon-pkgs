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
	type ChildForward,
	type InitAgentSetup,
	projectContextFile,
} from "../init/plan.js";
import { runScaffoldFollowUp } from "../init/tooling.js";
import { log } from "../log.js";
import type { AgentType } from "../mcp/agents.js";
import type { CommonProps } from "../types.js";
import { getCliName } from "../utils/cli_name.js";
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
	agent?: boolean;
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
	detectProjectAgents?: (
		cwd: string,
	) => readonly AgentType[] | Promise<readonly AgentType[]>;
	detectAgent?: () => AgentType | null;
	detectInstalledAgents?: () => Promise<readonly AgentType[]>;
};

const removedAgent = () =>
	`\`${getCliName()} bootstrap --agent\` was removed. List templates with \`${getCliName()} bootstrap --list-templates --output json\`. Scaffold with \`${getCliName()} bootstrap <directory> --template <id>\` or \`${getCliName()} bootstrap <directory> --default\`.`;

// The directory positional is optional: omitting it in an interactive terminal
// prompts for one. In a non-interactive context a missing directory is an error.
export const command = "bootstrap [directory]";
export const describe =
	"Scaffold a new project from a Neon starter template, then install agent tooling if a coding agent is detected and link a Neon project";

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
			agent: {
				hidden: true,
				type: "boolean",
			},
			default: {
				alias: "y",
				describe:
					"Quick start: scaffold the default template (or --template), then install, git, agent tooling (skipped if none), and link --yes. Skips those pickers; link --yes still asks for a project unless one is already linked",
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
				describe: `Run \`${getCliName()} link\` in the scaffolded directory after installing. In interactive mode this is offered as a prompt; use --no-link to skip without being asked.`,
				type: "boolean",
				default: true,
			},
			"agent-setup": {
				type: "boolean",
				default: true,
				describe:
					"After scaffolding, install the Neon plugin or skills and MCP when a coding agent is detected. Use --no-agent-setup to skip",
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
		.check((argv) => {
			if (argv.agent === true) {
				throw new Error(removedAgent());
			}
			return true;
		})
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
	await runPostScaffoldSteps(props, targetDir, interactive);
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
): Promise<void> => {
	const inferred = inferPackageManager(targetDir);
	const defaultPm = resolvePackageManager(targetDir);

	if (props.default) {
		await runDefaultSteps(props, targetDir, defaultPm);
		return;
	}

	if (!interactive) {
		printNextSteps(targetDir, defaultPm, {
			installed: false,
			suggestLink: true,
		});
		return;
	}

	// The package manager used for the install (and shown in the closing hint).
	// When we couldn't infer from the project or invocation we ask, so a globally
	// installed `neon` doesn't silently force npm on a bun/pnpm user.
	let pm: PackageManager = defaultPm;
	let installed = false;
	if (props.install && (await confirm(installPrompt(inferred)))) {
		pm = inferred ?? (await selectPackageManager());
		installed = await runCommand(pm, installArgs(pm), targetDir);
	}

	if (
		props.git &&
		!isGitRepo(targetDir) &&
		(await confirm("Initialize a git repository?"))
	) {
		await initGitRepo(targetDir);
	}

	const skipLink = shouldSkipLinkForDeps(targetDir, installed);
	if (props.link && skipLink) {
		logSkippedLink(pm);
	}

	const kids = bootstrapChildren(props, targetDir);
	await runScaffoldFollowUp({
		cwd: targetDir,
		yes: false,
		skipAgentSetup: props.agentSetup === false,
		shouldLink: false,
		linkYes: false,
		...kids,
		...(props.pickAgentSetup
			? { pickAgentSetup: props.pickAgentSetup }
			: {}),
		...(props.detectProjectAgents
			? { detectProjectAgents: props.detectProjectAgents }
			: {}),
		...(props.detectAgent ? { detectAgent: props.detectAgent } : {}),
		...(props.detectInstalledAgents
			? { detectInstalledAgents: props.detectInstalledAgents }
			: {}),
	});

	if (
		props.link &&
		!skipLink &&
		(await confirm(
			`Link this project to a Neon project now? (runs ${getCliName()} link)`,
		))
	) {
		await runScaffoldFollowUp({
			cwd: targetDir,
			yes: false,
			skipAgentSetup: true,
			shouldLink: true,
			linkYes: false,
			...kids,
		});
		printNextSteps(targetDir, pm, { installed, suggestLink: false });
		return;
	}

	printNextSteps(targetDir, pm, { installed, suggestLink: true });
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
): Promise<void> => {
	log.info(
		"Quick start (--default): skipping the template, install, git, and agent pickers. link --yes still asks for a project unless one is already linked.",
	);
	let installed = false;
	if (props.install) {
		installed = await runCommand(pm, installArgs(pm), targetDir);
	}
	if (props.git && !isGitRepo(targetDir)) {
		await initGitRepo(targetDir);
	}
	const skipLink = shouldSkipLinkForDeps(targetDir, installed);
	if (props.link && skipLink) {
		logSkippedLink(pm);
	}
	await runScaffoldFollowUp({
		cwd: targetDir,
		yes: true,
		skipAgentSetup: props.agentSetup === false,
		shouldLink: props.link && !skipLink,
		linkYes: true,
		...bootstrapChildren(props, targetDir),
		...(props.pickAgentSetup
			? { pickAgentSetup: props.pickAgentSetup }
			: {}),
		...(props.detectProjectAgents
			? { detectProjectAgents: props.detectProjectAgents }
			: {}),
		...(props.detectAgent ? { detectAgent: props.detectAgent } : {}),
		...(props.detectInstalledAgents
			? { detectInstalledAgents: props.detectInstalledAgents }
			: {}),
	});
	printNextSteps(targetDir, pm, {
		installed,
		suggestLink: !(props.link && !skipLink),
	});
};

const isGitRepo = (dir: string): boolean => existsSync(join(dir, ".git"));

// Config filenames the runtime loads (mirrors @neon/config). A scaffold
// that ships one makes `neon link`'s env pull evaluate it — which needs deps.
const NEON_CONFIG_FILENAMES = ["neon.ts", "neon.mts", "neon.js", "neon.mjs"];

const hasNeonConfig = (dir: string): boolean =>
	NEON_CONFIG_FILENAMES.some((name) => existsSync(join(dir, name)));

const shouldSkipLinkForDeps = (dir: string, installed: boolean): boolean =>
	!installed && hasNeonConfig(dir);

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
const initGitRepo = async (dir: string): Promise<void> => {
	await runCommand("git", ["init"], dir);
};

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
	log.info("");
	log.info(
		'Done. Scaffolded "%s" into %s.',
		template.title,
		isCurrentDir(targetDir)
			? "the current directory"
			: displayDir(targetDir),
	);
};

/**
 * The closing "Next steps" hint. Skips `cd` for the current directory, omits
 * the install line once deps are in, and only nudges `neon link` when linking
 * wasn't already offered/run — so the user never sees a step they just did.
 */
const printNextSteps = (
	targetDir: string,
	pm: PackageManager,
	opts: { installed: boolean; suggestLink: boolean },
): void => {
	log.info("");
	log.info("Next steps:");
	if (!isCurrentDir(targetDir)) {
		log.info("  cd %s", displayDir(targetDir));
	}
	if (!opts.installed) {
		log.info("  %s", formatInstallCommand(pm));
	}
	if (opts.suggestLink) {
		log.info(`  ${getCliName()} link`);
	}
	log.info("  See the README to run it.");
	log.info("");
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
