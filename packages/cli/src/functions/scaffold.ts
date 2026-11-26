import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
	asRelativeModulePath,
	ConfigEditError,
	declaredValue,
	declaresEntry,
	editNeonConfig,
	renderTriggerValue,
	type TriggerDeclaration,
	TYPESCRIPT_EXTENSION,
} from "../config_edit.js";
import { renderNeonConfig } from "../config_template.js";
import { readEnvFile } from "../env_file.js";
import {
	deriveFunctionSlug,
	FUNCTION_SLUG_HELP,
	FUNCTION_SLUG_PATTERN,
} from "../utils/function_slug.js";
import {
	type FunctionTemplate,
	type FunctionTemplateEnvironment,
	type FunctionTemplateOperation,
	type FunctionTemplateTrigger,
	resolveOperationById,
	type TemplateLayout,
} from "./registry.js";
import type { LoadedTemplate } from "./source.js";

export type OperationChoice = {
	operations?: string[];
	allOperations?: boolean;
};

export const operationsFromFlags = (
	template: FunctionTemplate,
	choice: OperationChoice,
): FunctionTemplateOperation[] | undefined => {
	const operations = template.operations ?? [];
	const explicit = choice.operations ?? [];
	if (choice.allOperations && explicit.length > 0) {
		throw new Error(
			"Pass either --all-operations or --operation, not both.",
		);
	}
	if (
		operations.length === 0 &&
		(choice.allOperations || explicit.length > 0)
	) {
		throw new Error(
			`Template "${template.id}" has no operations. Remove --operation and --all-operations.`,
		);
	}
	if (choice.allOperations) return [...operations];
	if (explicit.length > 0) {
		return [...new Set(explicit)].map((id) =>
			resolveOperationById(operations, id),
		);
	}
	return undefined;
};

export type ScaffoldFile = { path: string; contents: string };

export type ScaffoldFunction = {
	slug: string;
	name: string;
	operation?: string;
	file: string;
	env: string[];
};

export type ScaffoldPlan = {
	layout: TemplateLayout;
	files: ScaffoldFile[];
	functions: ScaffoldFunction[];
	routes?: string[];
	triggers: TriggerDeclaration[];
};

const routeOf = (operation: FunctionTemplateOperation): string =>
	operation.route ?? `/${operation.id}`;

const slugOf = (operation: FunctionTemplateOperation): string =>
	operation.slug ?? deriveFunctionSlug(operation.id);

const resolveTriggers = (
	template: FunctionTemplate,
	operations: readonly FunctionTemplateOperation[],
	slug: string,
): TriggerDeclaration[] =>
	template.triggers.flatMap((trigger: FunctionTemplateTrigger) => {
		let target: { function: string; functionPath?: string };
		if (trigger.operation === undefined) {
			target = { function: slug, functionPath: trigger.path };
		} else {
			const operation = operations.find(
				({ id }) => id === trigger.operation,
			);
			if (!operation) return [];
			target =
				template.layout === "separate"
					? {
							function: slugOf(operation),
							functionPath: trigger.path,
						}
					: { function: slug, functionPath: routeOf(operation) };
		}
		const path =
			target.functionPath === undefined || target.functionPath === "/"
				? {}
				: { functionPath: target.functionPath };
		const declaration: TriggerDeclaration =
			trigger.type === "schedule"
				? {
						name: trigger.name,
						type: trigger.type,
						function: target.function,
						cron: trigger.cron,
						...path,
					}
				: {
						name: trigger.name,
						type: trigger.type,
						function: target.function,
						bucket: trigger.bucket,
						...(trigger.prefix === undefined
							? {}
							: { prefix: trigger.prefix }),
						...path,
					};
		return [declaration];
	});

const routerSource = (
	operations: readonly FunctionTemplateOperation[],
): string => {
	const imports = operations
		.map(
			(operation, index) => `import op${index} from "./${operation.id}";`,
		)
		.join("\n");
	const entries = operations
		.map(
			(operation, index) =>
				`\t${JSON.stringify(routeOf(operation))}: op${index},`,
		)
		.join("\n");
	return `${imports}

const routes: Record<
\tstring,
\t{ fetch: (request: Request) => Response | Promise<Response> }
> = {
${entries}
};

const handler = {
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

export default handler;
`;
};

const sourceOf = (loaded: LoadedTemplate, path: string): string => {
	const text = loaded.sources.get(path);
	if (text === undefined) {
		throw new Error(
			`Template "${loaded.template.id}" did not load ${path}.`,
		);
	}
	return text;
};

export const planScaffold = (
	loaded: LoadedTemplate,
	operations: readonly FunctionTemplateOperation[],
	slug: string,
): ScaffoldPlan => {
	const { template } = loaded;
	const env = template.environment.map(({ name }) => name);
	if (!FUNCTION_SLUG_PATTERN.test(slug)) {
		throw new Error(
			`Invalid function slug "${slug}". ${FUNCTION_SLUG_HELP}`,
		);
	}
	if (template.layout === "separate") {
		for (const operation of operations) {
			const operationSlug = slugOf(operation);
			if (!FUNCTION_SLUG_PATTERN.test(operationSlug)) {
				throw new Error(
					`Template "${template.id}" gives operation ${JSON.stringify(operation.id)} the invalid function slug ${JSON.stringify(operationSlug)}. ${FUNCTION_SLUG_HELP}`,
				);
			}
		}
	}
	const triggers = resolveTriggers(template, operations, slug);
	if ((template.operations?.length ?? 0) === 0) {
		return {
			layout: template.layout,
			files: [
				{
					path: "index.ts",
					contents: sourceOf(loaded, "functions/index.ts"),
				},
			],
			functions: [{ slug, name: template.title, file: "index.ts", env }],
			triggers,
		};
	}
	if (operations.length === 0) {
		throw new Error("Select at least one operation.");
	}
	const modules = operations.map((operation) => ({
		path: `${operation.id}.ts`,
		contents: sourceOf(loaded, operation.source),
	}));
	if (template.layout === "separate") {
		return {
			layout: "separate",
			files: modules,
			functions: operations.map((operation) => ({
				slug: slugOf(operation),
				name: operation.title,
				operation: operation.id,
				file: `${operation.id}.ts`,
				env,
			})),
			triggers,
		};
	}
	return {
		layout: "router",
		files: [
			...modules,
			{ path: "index.ts", contents: routerSource(operations) },
		],
		functions: [{ slug, name: template.title, file: "index.ts", env }],
		routes: operations.map(routeOf),
		triggers,
	};
};

export const collidingFiles = (
	targetDir: string,
	files: readonly ScaffoldFile[],
): string[] =>
	files
		.filter(({ path, contents }) => {
			const target = join(targetDir, path);
			return (
				existsSync(target) && readFileSync(target, "utf8") !== contents
			);
		})
		.map(({ path }) => path);

export const writeScaffold = (
	targetDir: string,
	files: readonly ScaffoldFile[],
): void => {
	mkdirSync(targetDir, { recursive: true });
	for (const { path, contents } of files) {
		writeFileSync(join(targetDir, path), contents);
	}
};

export type ConfigRegistration = {
	source?: string;
	created: boolean;
	changes: string[];
	alreadyDeclared: string[];
	triggersDeclared: string[];
	triggersConflicting: string[];
	undeclaredBuckets: Array<{ name: string; byHand: boolean }>;
};

const sameDeclaration = (declared: string, rendered: string): boolean => {
	const normalize = (text: string) =>
		text.replace(/\s+/g, "").replace(/,\}$/, "}");
	return normalize(declared) === normalize(rendered);
};

const canAddBucket = (source: string, name: string): boolean => {
	if (declaresEntry(source, "buckets", name) !== false) return false;
	try {
		editNeonConfig(source, { kind: "bucket", name, access: "private" });
		return true;
	} catch (error) {
		if (error instanceof ConfigEditError) return false;
		throw error;
	}
};

export const planConfigRegistration = (
	configPath: string,
	targetDir: string,
	functions: readonly ScaffoldFunction[],
	triggers: readonly TriggerDeclaration[],
): ConfigRegistration => {
	const created = !existsSync(configPath);
	let source = created
		? renderNeonConfig([])
		: readFileSync(configPath, "utf8");
	const changes: string[] = [];
	const alreadyDeclared: string[] = [];
	for (const fn of functions) {
		const result = editNeonConfig(source, {
			kind: "function",
			slug: fn.slug,
			name: fn.name,
			source: asRelativeModulePath(
				relative(dirname(configPath), resolve(targetDir, fn.file))
					.split("\\")
					.join("/"),
			),
			env: fn.env,
			typescript: TYPESCRIPT_EXTENSION.test(configPath),
		});
		if (result.changes.length === 0) {
			alreadyDeclared.push(fn.slug);
			continue;
		}
		source = result.source;
		changes.push(...result.changes);
	}
	const triggersDeclared: string[] = [];
	const triggersConflicting: string[] = [];
	const watched = new Set<string>();
	for (const trigger of triggers) {
		const result = editNeonConfig(source, { kind: "trigger", ...trigger });
		if (result.changes.length === 0) {
			triggersDeclared.push(trigger.name);
			const declared = declaredValue(source, "triggers", trigger.name);
			if (
				declared === undefined ||
				!sameDeclaration(declared, renderTriggerValue(trigger))
			) {
				triggersConflicting.push(trigger.name);
			}
			continue;
		}
		source = result.source;
		changes.push(...result.changes);
		if (trigger.type === "storage_object_created")
			watched.add(trigger.bucket);
	}
	return {
		...(created || changes.length > 0 ? { source } : {}),
		created,
		changes,
		alreadyDeclared,
		triggersDeclared,
		triggersConflicting,
		undeclaredBuckets: [...watched]
			.filter((name) => declaresEntry(source, "buckets", name) !== true)
			.map((name) => ({ name, byHand: !canAddBucket(source, name) })),
	};
};

export type EnvExamplePlan = {
	path: string;
	contents?: string;
	added: string[];
};

export const planEnvExample = (
	projectRoot: string,
	environment: readonly FunctionTemplateEnvironment[],
): EnvExamplePlan => {
	const path = join(projectRoot, ".env.example");
	const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
	const declared = new Set(Object.keys(existing ? readEnvFile(path) : {}));
	const missing = environment.filter(({ name }) => !declared.has(name));
	if (missing.length === 0) return { path, added: [] };
	const block = missing
		.map(({ name, description }) => `# ${description}\n${name}=\n`)
		.join("\n");
	const separator =
		existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
	return {
		path,
		contents: `${existing}${separator}${block}`,
		added: missing.map(({ name }) => name),
	};
};
