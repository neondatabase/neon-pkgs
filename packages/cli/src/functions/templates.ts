import { writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import prompts from "prompts";
import { isCi } from "../env.js";
import { log } from "../log.js";
import type { TemplateFile } from "../templates/github.js";
import {
	ensureTargetUsable,
	materializeTemplateFiles,
	TemplateInputError,
} from "../templates/scaffold.js";
import { getCliName } from "../utils/cli_name.js";
import {
	formatInstallCommand,
	installArgs,
	resolvePackageManager,
	runCommand,
} from "../utils/package_manager.js";
import type { TriggerDeclaration } from "./config-editor.js";
import {
	applyConfigPlan,
	type ConfigOutcome,
	planConfigRegistration,
	type RegisterTarget,
	renderFragment,
} from "./config-register.js";
import {
	applyEnvSetup,
	type EnvSetupOutcome,
	type EnvVarSpec,
	planEnvSetup,
} from "./env-setup.js";
import {
	type BundleDelivery,
	type BundleManifest,
	type BundleTemplate,
	type BundleTrigger,
	extractBundle,
	type FunctionTemplate,
	type FunctionTemplateEnvironment,
	type FunctionTemplateOperation,
	fetchBundleZip,
	fetchFunctionTemplates,
	type LoadedTemplate,
	loadBundleItem,
	loadFunctionTemplate,
	MAX_TOTAL_BYTES,
	type RegistryIndexEntry,
	recommendedOperations,
	resolveOperationById,
	type TemplateLayout,
} from "./registry.js";

export type {
	FunctionTemplate,
	FunctionTemplateEnvironment,
	FunctionTemplateOperation,
	RegistryIndexEntry,
};
export { fetchFunctionTemplates };

const SLUG_PATTERN = /^[a-z0-9]{1,20}$/;
const SLUG_HELP =
	"Use 1-20 lowercase letters and digits (no hyphens or other characters).";

export class UnknownFunctionTemplateError extends Error {
	constructor(
		template: string,
		readonly templates: RegistryIndexEntry[],
	) {
		super(`Unknown function template "${template}".`);
		this.name = "UnknownFunctionTemplateError";
	}
}

export const deriveFunctionSlug = (templateId: string): string =>
	templateId
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.slice(0, 20);

const routerSource = (
	operations: readonly FunctionTemplateOperation[],
): string => {
	const binding = (index: number): string => `op${index}`;
	const imports = operations
		.map(
			(operation, index) =>
				`import ${binding(index)} from "./${operation.id}";`,
		)
		.join("\n");
	const entries = operations
		.map(
			(operation, index) =>
				`\t${JSON.stringify(operation.route ?? `/${operation.id}`)}: ${binding(index)},`,
		)
		.join("\n");
	return `${imports}

const routes: Record<
\tstring,
\t{ fetch: (request: Request) => Response | Promise<Response> }
> = {
${entries}
};

export default {
\tfetch(request: Request): Response | Promise<Response> {
\t\tconst { pathname } = new URL(request.url);
\t\tconst route = routes[pathname];
\t\tif (!route) {
\t\t\treturn Response.json(
\t\t\t\t{ error: "Not found", routes: Object.keys(routes) },
\t\t\t\t{ status: 404 },
\t\t\t);
\t\t}
\t\treturn route.fetch(request);
\t},
};
`;
};

const templateReadme = (
	title: string,
	extra: string,
	runLocally: string[],
	deploy: string[],
): string => `# ${title}

${extra}

## Run locally

\`\`\`sh
${runLocally.join("\n")}
\`\`\`

## Deploy

\`\`\`sh
${deploy.join("\n")}
\`\`\`
`;

const dedupeOperations = (
	operations: readonly FunctionTemplateOperation[],
	ids: readonly string[],
): FunctionTemplateOperation[] => {
	const seen = new Set<string>();
	const selected: FunctionTemplateOperation[] = [];
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		selected.push(resolveOperationById(operations, id));
	}
	return selected;
};

const customizeOperations = async (
	operations: readonly FunctionTemplateOperation[],
	provider: string,
	props: ScaffoldFunctionTemplateProps,
): Promise<string[] | undefined> => {
	if (props.chooseOperations) return props.chooseOperations(operations);
	const answer = await prompts({
		type: "multiselect",
		name: "value",
		message: `Which ${provider} operations should this function expose?`,
		hint: "Space to toggle. Enter to confirm.",
		choices: operations.map((operation) => ({
			title: operation.recommended
				? `${operation.id} (recommended)`
				: operation.id,
			description: operation.route
				? `${operation.route} — ${operation.description}`
				: operation.description,
			value: operation.id,
			selected: operation.recommended,
		})),
		min: 1,
		instructions: false,
	});
	return Array.isArray(answer.value) ? (answer.value as string[]) : undefined;
};

const selectOperations = async (
	operations: readonly FunctionTemplateOperation[],
	provider: string,
	props: ScaffoldFunctionTemplateProps,
	interactive: boolean,
): Promise<FunctionTemplateOperation[] | undefined> => {
	const explicit = props.operations ?? [];
	if (props.allOperations && explicit.length > 0) {
		throw new Error(
			"Pass either --all-operations or --operation, not both.",
		);
	}
	if (props.allOperations) return [...operations];
	if (explicit.length > 0) return dedupeOperations(operations, explicit);
	const recommended = recommendedOperations(operations);
	if (!interactive) return recommended;

	const useRecommended =
		props.confirmUseRecommended ??
		(async (message: string) => {
			const answer = await prompts({
				type: "select",
				name: "value",
				message,
				choices: [
					{
						title: "Yes, use recommended operations",
						description: recommended
							.map((operation) => operation.id)
							.join(", "),
						value: true,
					},
					{
						title: "No, customize operations",
						description:
							"Select operations with Space, then press Enter to confirm",
						value: false,
					},
				],
				initial: 0,
			});
			return typeof answer.value === "boolean" ? answer.value : undefined;
		});
	const decision = await useRecommended(
		`Use recommended operations for ${provider}?`,
	);
	if (decision === undefined) return undefined;
	if (decision) return recommended;

	const chosen = await customizeOperations(operations, provider, props);
	if (chosen === undefined || chosen.length === 0) return undefined;
	return dedupeOperations(operations, chosen);
};

const budgetedLoader = (
	loaded: LoadedTemplate,
): ((relativePath: string) => Promise<string>) => {
	let total = 0;
	return async (relativePath) => {
		const text = await loaded.loadSource(relativePath);
		total += Buffer.byteLength(text, "utf8");
		if (total > MAX_TOTAL_BYTES) {
			throw new Error(
				`Template "${loaded.template.id}" exceeds the ${MAX_TOTAL_BYTES}-byte total size limit.`,
			);
		}
		return text;
	};
};

const templateFile = (filePath: string, contents: string): TemplateFile => ({
	kind: "file",
	path: filePath,
	bytes: Buffer.from(contents),
	executable: false,
});

const deployEnvFlag = (envFileRel: string | undefined): string =>
	envFileRel ? ` --env-from-file ${envFileRel}` : "";

const envNote = (
	template: FunctionTemplate,
	envFileRel: string | undefined,
): string =>
	template.environment.length > 0 && envFileRel
		? ` Set ${template.environment.map((entry) => entry.name).join(", ")} in \`${envFileRel}\`.`
		: "";

const operationRoute = (operation: FunctionTemplateOperation): string =>
	operation.route ?? `/${operation.id}`;

const operationScaffoldFiles = async (
	template: FunctionTemplate,
	slug: string,
	path: string,
	operations: readonly FunctionTemplateOperation[],
	load: (relativePath: string) => Promise<string>,
	envFileRel: string | undefined,
): Promise<TemplateFile[]> => {
	const file = templateFile;
	const cli = getCliName();
	const flag = deployEnvFlag(envFileRel);
	const routeList = operations
		.map(
			(operation) =>
				`\`${operationRoute(operation)}\` → ${operation.title}`,
		)
		.join(", ");
	const providerLabel = template.provider ?? "Neon";
	const extra = `This ${providerLabel} function routes by URL path: ${routeList}. Any other path returns 404 with the valid routes.${envNote(template, envFileRel)}`;
	const files: TemplateFile[] = [];
	for (const operation of operations) {
		files.push(file(`${operation.id}.ts`, await load(operation.source)));
	}
	files.push(file("index.ts", routerSource(operations)));
	files.push(
		file(
			"README.md",
			templateReadme(
				template.title,
				extra,
				[`${cli} dev --source ${path}${flag}`],
				[`${cli} functions deploy ${slug} --src ${path}${flag}`],
			),
		),
	);
	return files;
};

const separateScaffoldFiles = async (
	template: FunctionTemplate,
	path: string,
	operations: readonly FunctionTemplateOperation[],
	load: (relativePath: string) => Promise<string>,
	envFileRel: string | undefined,
): Promise<TemplateFile[]> => {
	const file = templateFile;
	const cli = getCliName();
	const flag = deployEnvFlag(envFileRel);
	const deployList = operations
		.map((operation) => `\`${operation.slug}\` → \`${operation.id}.ts\``)
		.join(", ");
	const providerLabel = template.provider ?? "Neon";
	const extra = `This ${providerLabel} template deploys each operation as its own Neon Function: ${deployList}.${envNote(template, envFileRel)}`;
	const files: TemplateFile[] = [];
	for (const operation of operations) {
		files.push(file(`${operation.id}.ts`, await load(operation.source)));
	}
	files.push(
		file(
			"README.md",
			templateReadme(
				template.title,
				extra,
				operations.map(
					(operation) =>
						`${cli} dev --source ${path}/${operation.id}.ts${flag}`,
				),
				operations.map(
					(operation) =>
						`${cli} functions deploy ${operation.slug} --src ${path}/${operation.id}.ts${flag}`,
				),
			),
		),
	);
	return files;
};

const singleFileScaffoldFiles = async (
	template: FunctionTemplate,
	slug: string,
	path: string,
	load: (relativePath: string) => Promise<string>,
	envFileRel: string | undefined,
): Promise<TemplateFile[]> => {
	const file = templateFile;
	const hasEnv = template.environment.length > 0;
	const cli = getCliName();
	const flag = deployEnvFlag(envFileRel);
	const extra = hasEnv
		? `Set ${template.environment.map((entry) => entry.name).join(", ")}${envFileRel ? ` in \`${envFileRel}\`` : ""} before running.`
		: "This template has no dependencies or required environment variables.";
	const files: TemplateFile[] = [
		file("index.ts", await load("functions/index.ts")),
	];
	files.push(
		file(
			"README.md",
			templateReadme(
				template.title,
				extra,
				[`${cli} dev --source ${path}${flag}`],
				[`${cli} functions deploy ${slug} --src ${path}${flag}`],
			),
		),
	);
	return files;
};

export type ScaffoldFunctionTemplateProps = {
	template: string;
	name?: string;
	dir?: string;
	operations?: string[];
	allOperations?: boolean;
	yes?: boolean;
	force?: boolean;
	install?: boolean;
	cwd?: string;
	/** `--add-to-config` / `--no-add-to-config`. Omitted registers by default. */
	addToConfig?: boolean;
	/** Explicit `--config <path>` selecting the neon.ts to edit or create. */
	config?: string;
	/** `--no-env` opts out of touching a project dotenv file. */
	noEnv?: boolean;
	/** `--env-to <path>` picks the project dotenv file to append missing keys to. */
	envTo?: string;
	promptSecret?: (spec: EnvVarSpec) => Promise<string | undefined>;
	registry?: RegistryIndexEntry[];
	loadTemplate?: (
		id: string,
		registry: RegistryIndexEntry[],
	) => Promise<LoadedTemplate | undefined>;
	confirmOverwrite?: (message: string) => Promise<boolean | undefined>;
	confirmInstall?: (message: string) => Promise<boolean>;
	confirmUseRecommended?: (message: string) => Promise<boolean | undefined>;
	confirmRegister?: (message: string) => Promise<boolean | undefined>;
	confirmReplace?: (message: string) => Promise<boolean | undefined>;
	chooseOperations?: (
		operations: readonly FunctionTemplateOperation[],
	) => Promise<string[] | undefined>;
	interactive?: boolean;
	run?: typeof runCommand;
	quiet?: boolean;
};

export type ScaffoldFunctionResult = {
	slug: string;
	operation?: string;
	source: string;
};

export type ScaffoldFunctionTemplateResult = {
	template: FunctionTemplate;
	layout: TemplateLayout;
	slug: string;
	targetDir: string;
	directory: string;
	installed: boolean;
	dependencies: string[];
	environment: string[];
	operations?: string[];
	routes?: string[];
	/** The Neon function(s) this scaffold maps to: one for router, several for separate. */
	functions: ScaffoldFunctionResult[];
	/** The project dotenv file required variables were written to (names only, never values). */
	envFile?: { path: string; variables: string[]; written: string[] };
	nextSteps: string[];
	cancelled: boolean;
	config?: {
		path: string;
		action: "created" | "updated" | "replaced" | "noop";
		dependenciesInstalled?: boolean;
	};
	neonTsFragment?: string;
};

const displayPath = (cwd: string, targetDir: string): string => {
	const path = relative(cwd, targetDir);
	return path === "" ? "." : path.startsWith("..") ? targetDir : path;
};

export const scaffoldFunctionTemplate = async (
	props: ScaffoldFunctionTemplateProps,
): Promise<ScaffoldFunctionTemplateResult> => {
	const cwd = props.cwd ?? process.cwd();
	// Always resolve the merged registry so a trusted remote/local entry can
	// override a stale bundled copy; fetchFunctionTemplates falls back to the
	// bundled built-ins when the registry is unreachable.
	const registry = props.registry ?? (await fetchFunctionTemplates());
	const entry = registry.find((candidate) => candidate.id === props.template);
	const unknownError = () =>
		new UnknownFunctionTemplateError(props.template, registry);
	if (!entry) throw unknownError();

	const loaded = await (props.loadTemplate ?? loadFunctionTemplate)(
		props.template,
		registry,
	);
	if (!loaded) throw unknownError();
	const template = loaded.template;
	const isRemote = entry.path !== undefined;

	const slug =
		props.name !== undefined ? props.name : deriveFunctionSlug(template.id);
	if (!SLUG_PATTERN.test(slug)) {
		if (props.name !== undefined) {
			throw new Error(`Invalid function slug "${slug}". ${SLUG_HELP}`);
		}
		throw new Error(
			`Could not derive a valid function slug from template "${template.id}". Pass --name with 1-20 lowercase letters and digits.`,
		);
	}

	const targetDir = resolve(cwd, props.dir ?? `functions/${slug}`);
	const path = displayPath(cwd, targetDir);
	const interactive =
		props.interactive ??
		(props.yes !== true &&
			props.quiet !== true &&
			process.stdin.isTTY === true &&
			process.stdout.isTTY === true &&
			!isCi());

	const operations = template.operations ?? [];
	if (
		operations.length === 0 &&
		(props.allOperations === true || (props.operations?.length ?? 0) > 0)
	) {
		throw new Error(
			`Template "${template.id}" has no operations. Remove --operation and --all-operations.`,
		);
	}
	const provider = template.provider ?? "Neon";
	const selectedOperations =
		operations.length > 0
			? await selectOperations(operations, provider, props, interactive)
			: undefined;
	const layout: TemplateLayout = template.layout;
	const isSeparate =
		layout === "separate" &&
		selectedOperations !== undefined &&
		selectedOperations.length > 0;
	const envNames = template.environment.map(
		(environment) => environment.name,
	);

	// Router/single-file scaffolds register one function (the folder); separate
	// layout registers each selected operation under its own provider slug.
	const targets: RegisterTarget[] =
		isSeparate && selectedOperations
			? selectedOperations.map((operation) => ({
					slug: operation.slug ?? operation.id,
					displayName: operation.title,
					sourcePath: resolve(targetDir, `${operation.id}.ts`),
					environment: envNames,
				}))
			: [
					{
						slug,
						displayName: template.title,
						sourcePath: targetDir,
						environment: envNames,
					},
				];

	const functionsMapping = (): ScaffoldFunctionResult[] =>
		isSeparate && selectedOperations
			? selectedOperations.map((operation) => ({
					slug: operation.slug ?? operation.id,
					operation: operation.id,
					source: displayPath(
						cwd,
						resolve(targetDir, `${operation.id}.ts`),
					),
				}))
			: [{ slug, source: path }];

	const cancelledResult = (): ScaffoldFunctionTemplateResult => ({
		template,
		layout,
		slug,
		targetDir,
		directory: path,
		installed: false,
		dependencies: [...template.dependencies],
		environment: envNames,
		operations: selectedOperations?.map((operation) => operation.id),
		routes: isSeparate
			? undefined
			: selectedOperations?.map(operationRoute),
		functions: functionsMapping(),
		nextSteps: [],
		cancelled: true,
	});
	if (operations.length > 0 && selectedOperations === undefined) {
		if (!props.quiet) log.info("Aborted; no files were changed.");
		return cancelledResult();
	}
	if (!props.quiet && props.name === undefined && slug !== template.id) {
		log.info(
			`Using function slug "${slug}" (derived from template "${template.id}").`,
		);
	}

	try {
		ensureTargetUsable(targetDir, props.force === true);
	} catch (error) {
		if (
			!(error instanceof TemplateInputError) ||
			error.agentCode !== "TARGET_NOT_EMPTY"
		) {
			throw error;
		}
		if (props.force === false) {
			if (!props.quiet) log.info("Cancelled; no files were changed.");
			return cancelledResult();
		}
		if (!interactive) throw error;
		const confirmOverwrite =
			props.confirmOverwrite ??
			(async (message: string) => {
				const answer = await prompts({
					type: "confirm",
					name: "value",
					message,
					initial: false,
				});
				return answer.value;
			});
		const overwrite = await confirmOverwrite(
			`Target directory ${path} is not empty. Overwrite colliding template files? Unrelated files will be kept.`,
		);
		if (overwrite !== true) {
			if (!props.quiet) {
				log.info(
					overwrite === false
						? "Cancelled; no files were changed."
						: "Aborted; no files were changed.",
				);
			}
			return cancelledResult();
		}
	}

	const configPlan = await planConfigRegistration({
		cwd,
		targets,
		...(props.config !== undefined ? { configPath: props.config } : {}),
		...(props.addToConfig !== undefined
			? { addToConfig: props.addToConfig }
			: {}),
		...(props.force !== undefined ? { force: props.force } : {}),
		interactive,
		...(props.install !== undefined ? { install: props.install } : {}),
		...(props.confirmRegister
			? { confirmRegister: props.confirmRegister }
			: {}),
		...(props.confirmReplace
			? { confirmReplace: props.confirmReplace }
			: {}),
	});
	if (configPlan.kind === "cancelled") {
		if (!props.quiet) log.info("Aborted; no files were changed.");
		return cancelledResult();
	}

	if (isRemote && !props.quiet) {
		const by = template.provider ? ` by ${template.provider}` : "";
		log.info(
			`Fetching ${template.id}${by} from the Neon Function Registry.`,
		);
	}

	// Project root for env: the config's root when we register, else the cwd.
	const projectRoot =
		configPlan.kind === "create" ||
		configPlan.kind === "edit" ||
		configPlan.kind === "noop"
			? configPlan.root
			: cwd;
	const envVariables: EnvVarSpec[] = template.environment.map((entry) => ({
		name: entry.name,
		description: entry.description,
	}));
	const envPlan = await planEnvSetup({
		cwd,
		projectRoot,
		variables: envVariables,
		interactive,
		...(props.noEnv !== undefined ? { noEnv: props.noEnv } : {}),
		...(props.envTo !== undefined ? { envTo: props.envTo } : {}),
		...(props.promptSecret ? { promptSecret: props.promptSecret } : {}),
	});
	if (envPlan.kind === "cancelled") {
		if (!props.quiet) log.info("Aborted; no files were changed.");
		return cancelledResult();
	}
	const envFileRel =
		envPlan.kind === "write" ? envPlan.relativePath : undefined;

	const load = budgetedLoader(loaded);
	let files: TemplateFile[];
	if (isSeparate && selectedOperations) {
		files = await separateScaffoldFiles(
			template,
			path,
			selectedOperations,
			load,
			envFileRel,
		);
	} else if (selectedOperations) {
		files = await operationScaffoldFiles(
			template,
			slug,
			path,
			selectedOperations,
			load,
			envFileRel,
		);
	} else {
		files = await singleFileScaffoldFiles(
			template,
			slug,
			path,
			load,
			envFileRel,
		);
	}
	materializeTemplateFiles(files, targetDir, {
		onWarn: (message) => log.warning(message),
	});

	let configOutcome: ConfigOutcome;
	try {
		configOutcome = await applyConfigPlan(configPlan, {
			run: props.run ?? runCommand,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!props.quiet) {
			log.warning(
				`Scaffold succeeded but the Neon config was not updated: ${message}`,
			);
		}
		configOutcome = {
			registered: false,
			fragment:
				configPlan.kind === "create" || configPlan.kind === "edit"
					? renderFragment(configPlan.decls, configPlan.triggerDecls)
					: undefined,
			reason: `config write failed: ${message}`,
			hasEnv: false,
			envNames: [],
		};
	}

	let envOutcome: EnvSetupOutcome;
	try {
		envOutcome = applyEnvSetup(envPlan);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!props.quiet) {
			log.warning(
				`Scaffold succeeded but the env file was not updated: ${message}`,
			);
		}
		envOutcome = { written: [], present: [], variables: [] };
	}

	const pm = resolvePackageManager(cwd);
	let shouldInstall = props.install === true;
	if (
		props.install === undefined &&
		template.dependencies.length > 0 &&
		process.stdin.isTTY
	) {
		const confirmInstall =
			props.confirmInstall ??
			(async (message: string) => {
				const answer = await prompts({
					type: "confirm",
					name: "value",
					message,
					initial: true,
				});
				return answer.value === true;
			});
		shouldInstall = await confirmInstall(
			`Install ${template.dependencies.join(", ")} with ${pm}?`,
		);
	}

	let installed = false;
	if (shouldInstall && template.dependencies.length > 0) {
		installed = await (props.run ?? runCommand)(
			pm,
			installArgs(pm, template.dependencies),
			cwd,
		);
		if (!installed) {
			throw new Error(
				`Could not install template dependencies. Retry with: ${formatInstallCommand(pm, template.dependencies)}`,
			);
		}
	}

	const cli = getCliName();
	const envFile = envOutcome.path ? envOutcome.relativePath : undefined;
	const envSuffix = envFile ? ` --env-from-file ${envFile}` : "";
	const nextSteps: string[] = [];
	if (!installed && template.dependencies.length > 0) {
		nextSteps.push(
			`Install dependencies: ${formatInstallCommand(pm, template.dependencies)}`,
		);
	}
	if (configOutcome.depCommand) {
		nextSteps.push(
			`Install the Neon config packages: ${configOutcome.depCommand}`,
		);
	}
	if (envFile && template.environment.length > 0) {
		nextSteps.push(
			`Set ${template.environment.map((entry) => entry.name).join(", ")} in ${envFile}.`,
		);
	}
	const fns = functionsMapping();
	if (!isSeparate && selectedOperations && selectedOperations.length > 0) {
		nextSteps.push(
			`Routes: ${selectedOperations
				.map(operationRoute)
				.join(", ")}. Other paths return 404.`,
		);
	}
	if (configOutcome.registered) {
		const envFlag =
			configOutcome.hasEnv && envFile ? ` --env ${envFile}` : "";
		nextSteps.push(`Run locally: ${cli} dev`);
		nextSteps.push(`Deploy: ${cli} deploy${envFlag}`);
		if (configOutcome.hasEnv && envFile) {
			nextSteps.push(
				`Set ${configOutcome.envNames.join(", ")} in ${envFile} before deploying.`,
			);
		}
	} else {
		if (isSeparate) {
			for (const fn of fns) {
				nextSteps.push(
					`Run ${fn.slug} locally: ${cli} dev --source ${fn.source}${envSuffix}`,
				);
			}
			for (const fn of fns) {
				nextSteps.push(
					`Deploy ${fn.slug}: ${cli} functions deploy ${fn.slug} --src ${fn.source}${envSuffix}`,
				);
			}
		} else {
			nextSteps.push(
				`Run locally: ${cli} dev --source ${path}${envSuffix}`,
			);
			nextSteps.push(
				`Deploy: ${cli} functions deploy ${slug} --src ${path}${envSuffix}`,
			);
		}
		if (configOutcome.fragment) {
			nextSteps.push(
				`To manage ${isSeparate ? "these functions" : "this function"} with neon.ts, add to defineConfig:\n${configOutcome.fragment}`,
			);
			if (configOutcome.suggestInit) {
				nextSteps.push(`Or start a policy with: ${cli} config init.`);
			}
		}
	}

	if (!props.quiet) {
		const operationSuffix = selectedOperations
			? ` (${selectedOperations.map((operation) => operation.id).join(", ")})`
			: "";
		const by = template.provider ? ` by ${template.provider}` : "";
		const what = isSeparate
			? `${fns.length} functions`
			: `function ${slug}`;
		log.info(
			`Created ${what} from the ${template.id} template${by}${operationSuffix} in ${path}.`,
		);
		if (configOutcome.registered && configOutcome.action) {
			const label = (configOutcome.registeredSlugs ?? [slug]).join(", ");
			const verb = {
				created: `Created ${configOutcome.relativePath} and registered ${label}`,
				updated: `Registered ${label} in ${configOutcome.relativePath}`,
				replaced: `Replaced ${label} in ${configOutcome.relativePath}`,
				noop: `${label} is already registered in ${configOutcome.relativePath}`,
			}[configOutcome.action];
			log.info(`${verb}.`);
		} else if (configOutcome.reason) {
			log.info(
				`Left the Neon config untouched: ${configOutcome.reason}.`,
			);
		}
		for (const step of nextSteps) log.info(step);
	}

	return {
		template,
		layout,
		slug,
		targetDir,
		directory: path,
		installed,
		dependencies: [...template.dependencies],
		environment: envNames,
		operations: selectedOperations?.map((operation) => operation.id),
		routes: isSeparate
			? undefined
			: selectedOperations?.map(operationRoute),
		functions: fns,
		...(envFile
			? {
					envFile: {
						path: envFile,
						variables: envOutcome.variables,
						written: envOutcome.written,
					},
				}
			: {}),
		nextSteps,
		cancelled: false,
		...(configOutcome.registered && configOutcome.action
			? {
					config: {
						path: configOutcome.relativePath ?? "",
						action: configOutcome.action,
						...(configOutcome.depInstalled !== undefined
							? {
									dependenciesInstalled:
										configOutcome.depInstalled,
								}
							: {}),
					},
				}
			: {}),
		...(configOutcome.fragment
			? { neonTsFragment: configOutcome.fragment }
			: {}),
	};
};

/** A trigger the CLI cannot register, with why, so it can be surfaced as a manual step. */
export type UnsupportedTrigger = {
	type: string;
	reason: string;
	description?: string;
};

export type ClassifiedTriggers = {
	/** Triggers rendered into `neon.ts` in the same edit as the function. */
	registrable: TriggerDeclaration[];
	/** Triggers Neon config cannot express today; surfaced as manual next steps. */
	unsupported: UnsupportedTrigger[];
};

/** The trigger's type as declared in the block (an `unknown` trigger keeps its original string). */
const declaredTriggerType = (trigger: BundleTrigger): string =>
	trigger.type === "unknown" ? trigger.declaredType : trigger.type;

const triggerNameSegment = (functionPath: string | undefined): string =>
	(functionPath ?? "")
		.replace(/^\/+/, "")
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();

/**
 * Split a block's declared triggers into the ones the CLI can register in `neon.ts` and the ones
 * it must leave to the operator. Only `schedule` triggers are registrable: they need just the
 * function slug, a cron, and an optional path. A `storage_object_created` trigger needs a bucket
 * declared under `buckets` — Jeff's blocks name theirs through a runtime env var (`bucketEnv`) and
 * the bundle scaffolder declares no buckets, so registering one would reference an undeclared
 * bucket and produce an invalid config; it is surfaced as manual instead. Unknown types are never
 * fabricated. Trigger names are deterministic (`<slug>-<path-segment>`) and de-duplicated.
 */
export const classifyBundleTriggers = (
	triggers: BundleTrigger[],
	slug: string,
): ClassifiedTriggers => {
	const registrable: TriggerDeclaration[] = [];
	const unsupported: UnsupportedTrigger[] = [];
	const usedNames = new Set<string>();
	const uniqueName = (base: string): string => {
		let candidate = base;
		let suffix = 2;
		while (usedNames.has(candidate)) {
			candidate = `${base}-${suffix}`;
			suffix += 1;
		}
		usedNames.add(candidate);
		return candidate;
	};
	for (const trigger of triggers) {
		if (trigger.type === "schedule") {
			const segment = triggerNameSegment(trigger.functionPath);
			const name = uniqueName(
				segment ? `${slug}-${segment}` : `${slug}-schedule`,
			);
			registrable.push({
				name,
				type: "schedule",
				function: slug,
				cron: trigger.cron,
				...(trigger.functionPath && trigger.functionPath !== "/"
					? { functionPath: trigger.functionPath }
					: {}),
			});
		} else if (trigger.type === "storage_object_created") {
			const bucketRef = trigger.bucketEnv
				? `\`${trigger.bucketEnv}\``
				: "an environment variable";
			unsupported.push({
				type: "storage_object_created",
				reason: `names its bucket via ${bucketRef} and needs a bucket declared under \`buckets\` in neon.ts; declare the bucket, then add the trigger by hand`,
				...(trigger.description
					? { description: trigger.description }
					: {}),
			});
		} else {
			unsupported.push({
				type: trigger.declaredType,
				reason: "is not a trigger type Neon config supports today (only schedule and storage_object_created exist)",
				...(trigger.description
					? { description: trigger.description }
					: {}),
			});
		}
	}
	return { registrable, unsupported };
};

export type ScaffoldBundleProps = {
	entry: RegistryIndexEntry;
	name?: string;
	dir?: string;
	yes?: boolean;
	force?: boolean;
	cwd?: string;
	addToConfig?: boolean;
	config?: string;
	noEnv?: boolean;
	envTo?: string;
	promptSecret?: (spec: EnvVarSpec) => Promise<string | undefined>;
	confirmOverwrite?: (message: string) => Promise<boolean | undefined>;
	confirmRegister?: (message: string) => Promise<boolean | undefined>;
	confirmReplace?: (message: string) => Promise<boolean | undefined>;
	loadItem?: (entry: RegistryIndexEntry) => Promise<BundleTemplate>;
	fetchZip?: (entry: RegistryIndexEntry) => Promise<Uint8Array>;
	extract?: (zip: Uint8Array, targetDir: string) => BundleManifest;
	interactive?: boolean;
	quiet?: boolean;
};

export type ScaffoldBundleResult = {
	templateId: string;
	provider?: string;
	title: string;
	slug: string;
	targetDir: string;
	directory: string;
	/** Prebuilt entry module the deployed function loads (e.g. index.mjs). */
	entry?: string;
	bytes: number;
	sha256: string;
	capabilities: string[];
	dependsOn: string[];
	/** Every declared trigger type, in declaration order (for reporting). */
	triggers: string[];
	/** Names of the triggers written into `neon.ts`. */
	registeredTriggers: string[];
	/** Triggers Neon config cannot express, surfaced as manual steps. */
	unsupportedTriggers: UnsupportedTrigger[];
	migrations: string[];
	/** Every declared env var name (required, optional, and platform-injected). */
	environment: string[];
	injectedEnvironment: string[];
	envFile?: { path: string; variables: string[]; written: string[] };
	config?: {
		path: string;
		action: "created" | "updated" | "replaced" | "noop";
		dependenciesInstalled?: boolean;
	};
	neonTsFragment?: string;
	nextSteps: string[];
	cancelled: boolean;
};

const bundleNextStepsDoc = (
	item: BundleTemplate,
	slug: string,
	manifest: BundleManifest,
	registered: boolean,
	cli: string,
	directory: string,
	unappliedNote: string[],
	registeredTriggers: string[],
): string => {
	const lines: string[] = [
		`# ${item.title} — Neon setup`,
		"",
		`Installed as a prebuilt Neon Function under slug \`${slug}\` (bundler: none — the shipped \`${manifest.entry}\` is deployed as-is, not rebuilt).`,
		"",
		"## Run and deploy",
		"",
		registered
			? `- Run locally: \`${cli} dev\`\n- Deploy: \`${cli} deploy\``
			: `- Deploy: \`${cli} functions deploy ${slug} --src ${directory} --no-bundle\``,
	];
	if (registeredTriggers.length > 0) {
		lines.push(
			"",
			"## Triggers",
			"",
			`Registered in neon.ts and applied on \`${cli} deploy\`: ${registeredTriggers
				.map((name) => `\`${name}\``)
				.join(", ")}.`,
		);
	}
	if (unappliedNote.length > 0) {
		lines.push(
			"",
			"## Not applied automatically",
			"",
			"The Neon CLI installs the prebuilt function only. The following are shipped in this directory but are **not** applied for you yet — do them manually:",
			"",
			...unappliedNote.map((note) => `- ${note}`),
		);
	}
	if (item.environment.length > 0) {
		lines.push(
			"",
			"## Environment",
			"",
			...item.environment.map(
				(variable) =>
					`- \`${variable.name}\`${variable.injected ? " (injected by Neon)" : variable.required ? " (required)" : " (optional)"} — ${variable.description}`,
			),
		);
	}
	return `${lines.join("\n")}\n`;
};

/**
 * Scaffold a bundled (prebuilt) catalog block. Distinct from
 * {@link scaffoldFunctionTemplate}: the reviewed ZIP is downloaded, size- and
 * SHA-256-verified, and extracted verbatim — no operation selection, no
 * dependency install, no esbuild — then registered as exactly one `neon.ts`
 * function with `bundler: "none"`.
 */
export const scaffoldBundleTemplate = async (
	props: ScaffoldBundleProps,
): Promise<ScaffoldBundleResult> => {
	const { entry } = props;
	if (entry.delivery?.mode !== "bundle") {
		throw new Error(`Template "${entry.id}" is not a bundled artifact.`);
	}
	const delivery: BundleDelivery = entry.delivery;
	const cwd = props.cwd ?? process.cwd();
	const cli = getCliName();

	const slug =
		props.name !== undefined
			? props.name
			: SLUG_PATTERN.test(delivery.functionSlug)
				? delivery.functionSlug
				: deriveFunctionSlug(delivery.functionSlug || entry.id);
	if (!SLUG_PATTERN.test(slug)) {
		if (props.name !== undefined) {
			throw new Error(`Invalid function slug "${slug}". ${SLUG_HELP}`);
		}
		throw new Error(
			`Could not derive a valid function slug for "${entry.id}". Pass --name with 1-20 lowercase letters and digits.`,
		);
	}

	const targetDir = resolve(cwd, props.dir ?? `functions/${slug}`);
	const path = displayPath(cwd, targetDir);
	const interactive =
		props.interactive ??
		(props.yes !== true &&
			props.quiet !== true &&
			process.stdin.isTTY === true &&
			process.stdout.isTTY === true &&
			!isCi());

	const item = await (props.loadItem ?? loadBundleItem)(entry);
	const {
		registrable: registrableTriggers,
		unsupported: unsupportedTriggers,
	} = classifyBundleTriggers(item.triggers, slug);
	const injectedEnv = item.environment.filter(
		(variable) => variable.injected,
	);
	// A prebuilt block reads its own defaults for optional vars; only the required,
	// non-injected ones belong in neon.ts and the project dotenv prompt.
	const requiredEnv = item.environment.filter(
		(variable) => variable.required && !variable.injected,
	);
	const requiredEnvNames = requiredEnv.map((variable) => variable.name);
	const allEnvNames = item.environment.map((variable) => variable.name);

	const emptyResult = (cancelled: boolean): ScaffoldBundleResult => ({
		templateId: entry.id,
		...(item.provider ? { provider: item.provider } : {}),
		title: item.title,
		slug,
		targetDir,
		directory: path,
		bytes: delivery.bytes,
		sha256: delivery.sha256,
		capabilities: [...delivery.capabilities],
		dependsOn: [...delivery.dependsOn],
		triggers: item.triggers.map(declaredTriggerType),
		registeredTriggers: [],
		unsupportedTriggers,
		migrations: [],
		environment: allEnvNames,
		injectedEnvironment: injectedEnv.map((variable) => variable.name),
		nextSteps: [],
		cancelled,
	});

	try {
		ensureTargetUsable(targetDir, props.force === true);
	} catch (error) {
		if (
			!(error instanceof TemplateInputError) ||
			error.agentCode !== "TARGET_NOT_EMPTY"
		) {
			throw error;
		}
		if (props.force === false) {
			if (!props.quiet) log.info("Cancelled; no files were changed.");
			return emptyResult(true);
		}
		if (!interactive) throw error;
		const confirmOverwrite =
			props.confirmOverwrite ??
			(async (message: string) => {
				const answer = await prompts({
					type: "confirm",
					name: "value",
					message,
					initial: false,
				});
				return answer.value;
			});
		const overwrite = await confirmOverwrite(
			`Target directory ${path} is not empty. Overwrite colliding files? Unrelated files will be kept.`,
		);
		if (overwrite !== true) {
			if (!props.quiet) {
				log.info(
					overwrite === false
						? "Cancelled; no files were changed."
						: "Aborted; no files were changed.",
				);
			}
			return emptyResult(true);
		}
	}

	const configPlan = await planConfigRegistration({
		cwd,
		targets: [
			{
				slug,
				displayName: item.title,
				sourcePath: targetDir,
				environment: requiredEnvNames,
				bundler: "none",
			},
		],
		...(registrableTriggers.length > 0
			? { triggers: registrableTriggers }
			: {}),
		...(props.config !== undefined ? { configPath: props.config } : {}),
		...(props.addToConfig !== undefined
			? { addToConfig: props.addToConfig }
			: {}),
		...(props.force !== undefined ? { force: props.force } : {}),
		interactive,
		...(props.confirmRegister
			? { confirmRegister: props.confirmRegister }
			: {}),
		...(props.confirmReplace
			? { confirmReplace: props.confirmReplace }
			: {}),
	});
	if (configPlan.kind === "cancelled") {
		if (!props.quiet) log.info("Aborted; no files were changed.");
		return emptyResult(true);
	}

	const projectRoot =
		configPlan.kind === "create" ||
		configPlan.kind === "edit" ||
		configPlan.kind === "noop"
			? configPlan.root
			: cwd;
	const envPlan = await planEnvSetup({
		cwd,
		projectRoot,
		variables: requiredEnv.map((variable) => ({
			name: variable.name,
			description: variable.description,
		})),
		interactive,
		...(props.noEnv !== undefined ? { noEnv: props.noEnv } : {}),
		...(props.envTo !== undefined ? { envTo: props.envTo } : {}),
		...(props.promptSecret ? { promptSecret: props.promptSecret } : {}),
	});
	if (envPlan.kind === "cancelled") {
		if (!props.quiet) log.info("Aborted; no files were changed.");
		return emptyResult(true);
	}

	if (!props.quiet) {
		const by = item.provider ? ` by ${item.provider}` : "";
		log.info(
			`Fetching prebuilt ${entry.id}${by} (${delivery.bytes} bytes) from the Neon Function Registry.`,
		);
	}
	const zip = await (props.fetchZip ?? fetchBundleZip)(entry);
	const manifest = (props.extract ?? extractBundle)(zip, targetDir);
	if (!props.quiet) {
		log.info(
			`Verified SHA-256 ${delivery.sha256} and extracted to ${path}.`,
		);
	}

	let configOutcome: ConfigOutcome;
	try {
		configOutcome = await applyConfigPlan(configPlan, { run: runCommand });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!props.quiet) {
			log.warning(
				`Extracted the bundle but the Neon config was not updated: ${message}`,
			);
		}
		configOutcome = {
			registered: false,
			fragment:
				configPlan.kind === "create" || configPlan.kind === "edit"
					? renderFragment(configPlan.decls, configPlan.triggerDecls)
					: undefined,
			reason: `config write failed: ${message}`,
			hasEnv: false,
			envNames: [],
		};
	}

	let envOutcome: EnvSetupOutcome;
	try {
		envOutcome = applyEnvSetup(envPlan);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!props.quiet) {
			log.warning(
				`Extracted the bundle but the env file was not updated: ${message}`,
			);
		}
		envOutcome = { written: [], present: [], variables: [] };
	}

	const registeredTriggers = configOutcome.registeredTriggers ?? [];
	const unapplied: string[] = [];
	if (manifest.migrations.length > 0) {
		unapplied.push(
			`${manifest.migrations.length} SQL migration${manifest.migrations.length > 1 ? "s" : ""} under \`migrations/\` — apply them to your branch before invoking the function.`,
		);
	}
	for (const trigger of unsupportedTriggers) {
		unapplied.push(
			`\`${trigger.type}\` trigger ${trigger.reason}.${trigger.description ? ` (${trigger.description})` : ""}`,
		);
	}
	if (delivery.dependsOn.length > 0) {
		unapplied.push(
			`dependent block${delivery.dependsOn.length > 1 ? "s" : ""} ${delivery.dependsOn.join(", ")} — install ${delivery.dependsOn.length > 1 ? "them" : "it"} too.`,
		);
	}

	const doc = bundleNextStepsDoc(
		item,
		slug,
		manifest,
		configOutcome.registered,
		cli,
		path,
		unapplied,
		registeredTriggers,
	);
	try {
		writeFileSync(join(targetDir, "NEON_NEXT_STEPS.md"), doc);
	} catch (error) {
		if (!props.quiet) {
			log.warning(
				`Could not write NEON_NEXT_STEPS.md: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const envFile = envOutcome.path ? envOutcome.relativePath : undefined;
	const nextSteps: string[] = [];
	if (configOutcome.registered) {
		nextSteps.push(`Run locally: ${cli} dev`);
		nextSteps.push(`Deploy the prebuilt function: ${cli} deploy`);
		if (registeredTriggers.length > 0) {
			nextSteps.push(
				`Registered ${registeredTriggers.length} trigger${registeredTriggers.length > 1 ? "s" : ""} in neon.ts (${registeredTriggers.join(", ")}); applied on ${cli} deploy.`,
			);
		}
	} else {
		nextSteps.push(
			`Deploy the prebuilt function: ${cli} functions deploy ${slug} --src ${path} --no-bundle`,
		);
		if (configOutcome.fragment) {
			nextSteps.push(
				`To manage this function with neon.ts, add to defineConfig:\n${configOutcome.fragment}`,
			);
			if (configOutcome.suggestInit) {
				nextSteps.push(`Or start a policy with: ${cli} config init.`);
			}
		}
	}
	if (requiredEnvNames.length > 0 && envFile) {
		nextSteps.push(`Set ${requiredEnvNames.join(", ")} in ${envFile}.`);
	}
	for (const note of unapplied) {
		nextSteps.push(`Not applied automatically: ${note}`);
	}
	nextSteps.push(
		`See ${path}/NEON_NEXT_STEPS.md for the full setup checklist.`,
	);

	if (!props.quiet) {
		const by = item.provider ? ` by ${item.provider}` : "";
		log.info(
			`Installed prebuilt function ${slug} from the ${entry.id} block${by} in ${path}.`,
		);
		if (configOutcome.registered && configOutcome.action) {
			const verb = {
				created: `Created ${configOutcome.relativePath} and registered ${slug}`,
				updated: `Registered ${slug} in ${configOutcome.relativePath}`,
				replaced: `Replaced ${slug} in ${configOutcome.relativePath}`,
				noop: `${slug} is already registered in ${configOutcome.relativePath}`,
			}[configOutcome.action];
			log.info(`${verb} (bundler: none).`);
		} else if (configOutcome.reason) {
			log.info(
				`Left the Neon config untouched: ${configOutcome.reason}.`,
			);
		}
		for (const step of nextSteps) log.info(step);
	}

	return {
		templateId: entry.id,
		...(item.provider ? { provider: item.provider } : {}),
		title: item.title,
		slug,
		targetDir,
		directory: path,
		entry: manifest.entry,
		bytes: delivery.bytes,
		sha256: delivery.sha256,
		capabilities: [...delivery.capabilities],
		dependsOn: [...delivery.dependsOn],
		triggers: item.triggers.map(declaredTriggerType),
		registeredTriggers,
		unsupportedTriggers,
		migrations: manifest.migrations,
		environment: allEnvNames,
		injectedEnvironment: injectedEnv.map((variable) => variable.name),
		...(envFile
			? {
					envFile: {
						path: envFile,
						variables: envOutcome.variables,
						written: envOutcome.written,
					},
				}
			: {}),
		...(configOutcome.registered && configOutcome.action
			? {
					config: {
						path: configOutcome.relativePath ?? "",
						action: configOutcome.action,
						...(configOutcome.depInstalled !== undefined
							? {
									dependenciesInstalled:
										configOutcome.depInstalled,
								}
							: {}),
					},
				}
			: {}),
		...(configOutcome.fragment
			? { neonTsFragment: configOutcome.fragment }
			: {}),
		nextSteps,
		cancelled: false,
	};
};
