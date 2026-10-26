import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import prompts from "prompts";
import { isInteractiveTerminal } from "../env.js";
import { resolveEnvFilePath } from "../env_file.js";
import {
	type FunctionTemplateOperation,
	type RegistryIndexEntry,
	recommendedOperations,
	type TemplateLayout,
} from "../functions/registry.js";
import {
	collidingFiles,
	operationsFromFlags,
	planConfigRegistration,
	planEnvExample,
	planScaffold,
	type ScaffoldFunction,
	writeScaffold,
} from "../functions/scaffold.js";
import {
	describeRegistrySource,
	openRegistry,
	type Registry,
} from "../functions/source.js";
import {
	formatInitDone,
	type InitDoneRow,
	printInitDone,
} from "../init/chrome.js";
import { log } from "../log.js";
import { projectConfigPath, projectDir } from "../project.js";
import type { BranchScopeProps } from "../types.js";
import { getCliName } from "../utils/cli_name.js";
import {
	deriveFunctionSlug,
	FUNCTION_SLUG_PATTERN,
} from "../utils/function_slug.js";
import {
	installArgs,
	type PackageManager,
	resolvePackageManager,
	runCommand,
} from "../utils/package_manager.js";
import { writer } from "../writer.js";
import {
	ensureConfigPackages,
	installCommandFrom,
	missingDependencies,
} from "./config.js";
import { displayPath } from "./env_output.js";

const TEMPLATE_FIELDS = ["id", "title", "provider", "description"] as const;

const NEW_FUNCTION_FIELDS = [
	"template",
	"layout",
	"operations",
	"routes",
	"functions",
	"directory",
	"config",
	"dependencies",
	"installed",
	"environment",
	"env_example",
	"next_steps",
] as const;

type OutputProps = Pick<BranchScopeProps, "output">;

export type ScaffoldFromTemplateOptions = {
	template: string;
	slug?: string;
	operations?: string[];
	allOperations?: boolean;
	dir?: string;
	force?: boolean;
	install?: boolean;
	addToConfig?: boolean;
	config?: string;
	contextFile?: string;
	cwd?: string;
	registry?: Registry;
	interactive: boolean;
	run?: typeof runCommand;
};

export type ScaffoldedFunction = Pick<
	ScaffoldFunction,
	"slug" | "name" | "operation"
> & { source: string };

export type ScaffoldFromTemplateResult =
	| { cancelled: true }
	| {
			cancelled: false;
			template: string;
			title: string;
			provider: string;
			layout: TemplateLayout;
			operations: string[];
			routes?: string[];
			functions: ScaffoldedFunction[];
			directory: string;
			config?: {
				path: string;
				action: "created" | "updated";
				changes: string[];
			};
			dependencies: string[];
			packages: string[];
			packageManager: PackageManager;
			installed: boolean;
			install: "installed" | "failed" | "skipped";
			environment: string[];
			envExample?: { path: string; added: string[] };
			nextSteps: string[];
			next: string[];
	  };

export type NewFunctionProps = OutputProps &
	Omit<
		ScaffoldFromTemplateOptions,
		"template" | "operations" | "cwd" | "registry" | "interactive" | "run"
	> & {
		template?: string;
		operation?: string[];
		yes?: boolean;
	};

const structured = (props: OutputProps) =>
	props.output === "json" || props.output === "yaml";

const providerOf = (item: { provider?: string }): string =>
	item.provider ?? "Neon";

const writeTemplates = (
	props: OutputProps,
	entries: readonly RegistryIndexEntry[],
) =>
	writer(props).end(
		entries.map((entry) => ({
			id: entry.id,
			title: entry.title,
			provider: providerOf(entry),
			description: entry.description,
		})),
		{
			fields: TEMPLATE_FIELDS,
			emptyMessage: "No function templates found.",
		},
	);

export const listTemplates = async (props: OutputProps): Promise<void> => {
	writeTemplates(props, (await openRegistry()).entries);
};

const unknownTemplate = (id: string, registry: Registry): Error =>
	new Error(
		`Unknown function template "${id}" in ${describeRegistrySource(registry.source)}. Available templates: ${registry.entries
			.map((entry) => entry.id)
			.join(", ")}.`,
	);

const pickOperations = async (
	operations: readonly FunctionTemplateOperation[],
	provider: string,
): Promise<FunctionTemplateOperation[] | undefined> => {
	const answer = await prompts({
		type: "multiselect",
		name: "value",
		message: `Which ${provider} operations should this function expose?`,
		hint: "Space to toggle. Enter to confirm.",
		choices: operations.map((operation) => ({
			title: operation.id,
			description: operation.description,
			value: operation.id,
			selected: operation.recommended,
		})),
		min: 1,
		instructions: false,
	});
	if (!Array.isArray(answer.value)) return undefined;
	const chosen = new Set<string>(answer.value);
	return operations.filter((operation) => chosen.has(operation.id));
};

const confirm = async (message: string, initial: boolean) => {
	const answer = await prompts({
		type: "confirm",
		name: "value",
		message,
		initial,
	});
	return answer.value as boolean | undefined;
};

const assertSlug = (slug: string | undefined): void => {
	if (slug === undefined || FUNCTION_SLUG_PATTERN.test(slug)) return;
	const suggestion = deriveFunctionSlug(slug);
	throw new Error(
		`"${slug}" is not a valid function slug: use 1-20 lowercase letters and digits, no hyphens.` +
			(suggestion ? ` Try "${suggestion}".` : ""),
	);
};

export const scaffoldFromTemplate = async (
	options: ScaffoldFromTemplateOptions,
): Promise<ScaffoldFromTemplateResult> => {
	assertSlug(options.slug);
	const registry = options.registry ?? (await openRegistry());
	const entry = registry.entries.find(({ id }) => id === options.template);
	if (!entry) throw unknownTemplate(options.template, registry);

	const cwd = options.cwd ?? process.cwd();
	const { interactive } = options;
	const loaded = await registry.load(entry);
	const { template } = loaded;
	const provider = providerOf(template);

	let operations: FunctionTemplateOperation[] =
		operationsFromFlags(template, {
			operations: options.operations,
			allOperations: options.allOperations,
		}) ?? recommendedOperations(template.operations ?? []);
	if (
		interactive &&
		options.operations === undefined &&
		options.allOperations === undefined &&
		(template.operations?.length ?? 0) > 1
	) {
		const picked = await pickOperations(
			template.operations ?? [],
			provider,
		);
		if (picked === undefined) return { cancelled: true };
		operations = picked;
	}

	const slug = options.slug ?? deriveFunctionSlug(template.id);
	const plan = planScaffold(loaded, operations, slug);

	const location = {
		cwd,
		...(options.contextFile ? { contextFile: options.contextFile } : {}),
	};
	const configPath = options.config
		? resolve(cwd, options.config)
		: (projectConfigPath(location) ??
			join(projectDir(location), "neon.ts"));
	const projectRoot = dirname(configPath);
	const targetDir = options.dir
		? resolve(cwd, options.dir)
		: join(projectRoot, "functions", slug);
	const directory = displayPath(targetDir, cwd);

	const collisions = collidingFiles(targetDir, plan.files);
	if (collisions.length > 0 && options.force !== true) {
		const list = collisions.join(", ");
		if (!interactive || options.force === false) {
			throw new Error(
				`${directory} already has different ${list}. Pass --force to overwrite, or --dir to scaffold elsewhere.`,
			);
		}
		const overwrite = await confirm(
			`${directory} already has different ${list}. Overwrite?`,
			false,
		);
		if (overwrite !== true) return { cancelled: true };
	}

	const register = options.addToConfig !== false;
	const registration = register
		? planConfigRegistration(configPath, targetDir, plan.functions)
		: undefined;
	if (
		registration &&
		registration.alreadyDeclared.length > 0 &&
		!options.force
	) {
		const declared = `${displayPath(configPath, cwd)} already declares ${registration.alreadyDeclared.join(", ")}.`;
		throw new Error(
			plan.layout === "separate"
				? `${declared} The template sets these slugs, so --slug cannot change them. Remove them from neon.ts, pass --force to keep the declarations and overwrite the files, or pass --no-add-to-config.`
				: `${declared} Pass --slug to pick another one, --force to keep the declaration and overwrite the files, or --no-add-to-config.`,
		);
	}

	const envExample = planEnvExample(projectRoot, template.environment);

	writeScaffold(targetDir, plan.files);
	if (registration?.source !== undefined) {
		writeFileSync(configPath, registration.source);
	}
	if (envExample.contents !== undefined) {
		writeFileSync(envExample.path, envExample.contents);
	}
	const { dependencies } = template;
	const pm = resolvePackageManager(projectRoot);
	const installHint = (packages: readonly string[], exact = false) =>
		installCommandFrom(projectRoot, pm, packages, { exact });
	const configPackages = registration?.created
		? missingDependencies(projectRoot)
		: [];
	const packages = [...configPackages, ...dependencies];
	let install = options.install === true;
	if (options.install === undefined && packages.length > 0 && interactive) {
		install =
			(await confirm(
				`Install ${packages.join(", ")} with ${pm}?`,
				true,
			)) === true;
	}
	if (configPackages.length > 0) {
		await ensureConfigPackages(projectRoot, {
			install,
			packageManager: pm,
			...(options.run ? { run: options.run } : {}),
			silent: true,
		});
	}
	let installed = false;
	if (install && dependencies.length > 0) {
		installed = await (options.run ?? runCommand)(
			pm,
			installArgs(pm, dependencies, { exact: true }),
			projectRoot,
		);
		if (!installed) {
			log.warning(
				"Could not install %s. Run by hand: `%s`",
				dependencies.join(", "),
				installHint(dependencies, true),
			);
		}
	}

	const cli = getCliName();
	const functions = plan.functions.map((fn) => ({
		slug: fn.slug,
		name: fn.name,
		...(fn.operation ? { operation: fn.operation } : {}),
		source: displayPath(join(targetDir, fn.file), cwd),
	}));
	const nextSteps: string[] = [];
	const next: string[] = [];
	const missingConfig = registration?.created
		? missingDependencies(projectRoot)
		: [];
	if (missingConfig.length > 0) {
		nextSteps.push(
			`Install the Neon config packages: \`${installHint(missingConfig)}\``,
		);
		next.push(installHint(missingConfig));
	}
	if (dependencies.length > 0 && !installed) {
		nextSteps.push(
			`Install the template's dependencies: \`${installHint(dependencies, true)}\``,
		);
		next.push(installHint(dependencies, true));
	}
	const environment = template.environment.map(({ name }) => name);
	const variables = template.environment
		.map((variable) => `${variable.name} (${variable.description})`)
		.join(", ");
	const envFile = displayPath(resolveEnvFilePath(location), cwd);
	const names = environment.join(", ");
	if (variables && register) {
		const them = environment.length === 1 ? "it" : "them";
		nextSteps.push(
			`Set ${variables} in ${envFile}. \`${cli} dev\` reads ${them} from your shell, so export ${them} there too.`,
		);
		next.push(
			`Set ${names} in ${envFile}, and export ${them} for ${cli} dev`,
		);
	} else if (variables) {
		nextSteps.push(`Set ${variables} in your shell.`);
		next.push(`Set ${names} in your shell`);
	}
	if (plan.routes) {
		nextSteps.push(
			`Routes: ${plan.routes.join(", ")}. Other paths return 404.`,
		);
	}
	if (register) {
		const flag = options.config ? ` --config ${options.config}` : "";
		const envFlag = variables ? ` --env ${envFile}` : "";
		nextSteps.push(
			`Next: \`${cli} dev${flag}\` to run it locally, \`${cli} config apply${flag}${envFlag}\` to deploy.`,
		);
		next.push(`${cli} dev${flag}`, `${cli} config apply${flag}${envFlag}`);
	} else {
		const envFlags = environment
			.map((name) => ` --env ${name}=<value>`)
			.join("");
		for (const fn of functions) {
			nextSteps.push(
				`Next: \`${cli} dev --source ${fn.source}\` to run ${fn.slug} locally, \`${cli} functions deploy ${fn.slug} --src ${fn.source}${envFlags}\` to deploy.`,
			);
			next.push(
				`${cli} dev --source ${fn.source}`,
				`${cli} functions deploy ${fn.slug} --src ${fn.source}${envFlags}`,
			);
		}
	}

	return {
		cancelled: false,
		template: template.id,
		title: template.title,
		provider,
		layout: plan.layout,
		operations: operations.map(({ id }) => id),
		...(plan.routes ? { routes: plan.routes } : {}),
		functions,
		directory,
		...(registration && registration.changes.length > 0
			? {
					config: {
						path: displayPath(configPath, cwd),
						action: registration.created ? "created" : "updated",
						changes: registration.changes,
					},
				}
			: {}),
		dependencies: [...dependencies],
		packages,
		packageManager: pm,
		installed,
		install:
			packages.length === 0 || !install
				? "skipped"
				: missingConfig.length > 0 ||
						(dependencies.length > 0 && !installed)
					? "failed"
					: "installed",
		environment,
		...(envExample.added.length > 0
			? {
					envExample: {
						path: displayPath(envExample.path, cwd),
						added: envExample.added,
					},
				}
			: {}),
		nextSteps,
		next,
	};
};

type ScaffoldedTemplate = Extract<
	ScaffoldFromTemplateResult,
	{ cancelled: false }
>;

export const formatNewFunctionDone = (result: ScaffoldedTemplate): string => {
	const plural = result.functions.length !== 1;
	const rows: InitDoneRow[] = [
		{ label: "Template", value: `${result.title} (${result.provider})` },
		{
			label: plural ? "Functions" : "Function",
			value: result.functions.map(({ slug }) => slug).join(", "),
		},
		{ label: "Directory", value: result.directory },
	];
	if (result.routes) {
		rows.push({
			label: "Routes",
			value: `${result.routes.join(", ")} (other paths return 404)`,
		});
	}
	rows.push({
		label: "Config",
		value: result.config
			? `${result.config.path} ${result.config.action}: ${result.config.changes.join(", ")}`
			: "not added",
	});
	if (result.packages.length > 0) {
		rows.push({
			label: "Dependencies",
			value:
				result.install === "failed"
					? "install failed"
					: result.install === "installed"
						? `installed with ${result.packageManager}`
						: "not installed",
		});
	}
	if (result.envExample) {
		rows.push({
			label: "Env",
			value: `${result.envExample.added.join(", ")} added to ${result.envExample.path}`,
		});
	} else if (result.environment.length > 0) {
		rows.push({ label: "Env", value: result.environment.join(", ") });
	}
	return formatInitDone({
		heading:
			result.install === "failed"
				? "Setup did not finish."
				: plural
					? "Functions created."
					: "Function created.",
		rows,
		next: result.next,
	});
};

const pickTemplate = async (
	entries: readonly RegistryIndexEntry[],
): Promise<string | undefined> => {
	const answer = await prompts({
		type: "select",
		name: "value",
		message: "Which template would you like to use?",
		choices: entries.map((entry) => ({
			title: `${entry.title} (${providerOf(entry)})`,
			description: entry.description,
			value: entry.id,
		})),
		initial: 0,
	});
	return typeof answer.value === "string" ? answer.value : undefined;
};

export const handleNew = async (props: NewFunctionProps): Promise<void> => {
	const interactive =
		props.yes !== true && !structured(props) && isInteractiveTerminal();
	assertSlug(props.slug);
	const registry = await openRegistry();
	let template = props.template;
	if (template === undefined) {
		if (!interactive) {
			throw new Error(
				`No template selected. Re-run in an interactive terminal to pick one, or pass a template ID. Available templates: ${registry.entries
					.map((entry) => entry.id)
					.join(", ")}.`,
			);
		}
		template = await pickTemplate(registry.entries);
		if (template === undefined) {
			log.info("Cancelled; no files were changed.");
			return;
		}
	}
	if (!structured(props)) {
		log.info(
			'Fetching template "%s" from the Function Registry…',
			template,
		);
	}
	const result = await scaffoldFromTemplate({
		template,
		slug: props.slug,
		operations: props.operation,
		allOperations: props.allOperations,
		dir: props.dir,
		force: props.force,
		install: props.install ?? (props.yes === true ? true : undefined),
		addToConfig: props.addToConfig,
		config: props.config,
		contextFile: props.contextFile,
		registry,
		interactive,
	});
	if (result.cancelled) {
		log.info("Cancelled; no files were changed.");
		return;
	}

	if (structured(props)) {
		writer(props).end(
			{
				template: result.template,
				layout: result.layout,
				operations: result.operations,
				routes: result.routes ?? null,
				functions: result.functions,
				directory: result.directory,
				config: result.config
					? { path: result.config.path, action: result.config.action }
					: null,
				dependencies: result.dependencies,
				installed: result.installed,
				environment: result.environment,
				env_example: result.envExample ?? null,
				next_steps: result.nextSteps,
			},
			{ fields: NEW_FUNCTION_FIELDS },
		);
		return;
	}

	printInitDone(formatNewFunctionDone(result));
};
