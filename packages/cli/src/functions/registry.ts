import { FUNCTION_SLUG_PATTERN } from "../utils/function_slug.js";

const MAX_PATH_LENGTH = 255;
const MAX_INDEX_ENTRIES = 500;
const MAX_OPERATIONS = 40;
const MAX_LOGO_URL_LENGTH = 2048;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_JSON_BYTES = 1 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string =>
	typeof value === "string" && value.trim() !== "";

const matches = (value: unknown, pattern: RegExp): value is string =>
	typeof value === "string" && pattern.test(value);

const isOptionalString = (value: unknown): value is string | undefined =>
	value === undefined || typeof value === "string";

const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]*$/;
const OPERATION_ID = /^[a-z0-9][a-z0-9-]*$/;
const OPERATION_SLUG = FUNCTION_SLUG_PATTERN;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SINGLE_LINE = /^[^\r\n]*$/;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:/;
const SOURCE_EXTENSION = /\.ts$/;
const ROUTE_PATTERN = /^\/[A-Za-z0-9\-._~/]*$/;

const EXACT_DEPENDENCY =
	/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const TEMPLATE_LAYOUTS = ["router", "separate"] as const;

export const REGISTRY_CONTRACT = {
	layouts: TEMPLATE_LAYOUTS,
	requiredTemplateFields: ["id", "title", "description", "layout"],
	requiredOperationFields: [
		"id",
		"title",
		"description",
		"source",
		"recommended",
	],
	templateId: TEMPLATE_ID,
	operationId: OPERATION_ID,
	operationSlug: OPERATION_SLUG,
	envName: ENV_NAME,
	envDescription: SINGLE_LINE,
	source: SOURCE_EXTENSION,
	route: ROUTE_PATTERN,
	dependency: EXACT_DEPENDENCY,
	maxOperations: MAX_OPERATIONS,
	maxIndexEntries: MAX_INDEX_ENTRIES,
	maxFileBytes: MAX_FILE_BYTES,
	maxJsonBytes: MAX_JSON_BYTES,
} as const;

export const isContainedRelativePath = (value: string): boolean =>
	value !== "" &&
	value.length <= MAX_PATH_LENGTH &&
	!value.includes("\0") &&
	!value.includes("\\") &&
	!value.startsWith("/") &&
	!WINDOWS_ABSOLUTE.test(value) &&
	!value
		.split("/")
		.some((part) => part === "" || part === "." || part === "..");

const isSafeSourcePath = (value: string): boolean =>
	isContainedRelativePath(value) && SOURCE_EXTENSION.test(value);

const isDisplayLogoUrl = (value: string): boolean => {
	if (value.length > MAX_LOGO_URL_LENGTH || !URL.canParse(value)) {
		return false;
	}
	return new URL(value).protocol === "https:";
};

export type FunctionTemplateEnvironment = {
	name: string;
	description: string;
};

export type TemplateLayout = "router" | "separate";

export type FunctionTemplateOperation = {
	id: string;
	title: string;
	description: string;
	source: string;
	route?: string;
	slug?: string;
	recommended: boolean;
};

export type FunctionTemplate = {
	id: string;
	provider?: string;
	title: string;
	description: string;
	layout: TemplateLayout;
	dependencies: string[];
	environment: FunctionTemplateEnvironment[];
	operations?: FunctionTemplateOperation[];
};

export type RegistryIndexEntry = {
	id: string;
	provider?: string;
	title: string;
	description: string;
	path?: string;
	logo?: string;
};

const stringList = (value: unknown): string[] | undefined => {
	if (
		!Array.isArray(value) ||
		!value.every((item) => typeof item === "string")
	) {
		return undefined;
	}
	return value;
};

export const parseEnvironment = (
	value: unknown,
): FunctionTemplateEnvironment[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	const result: FunctionTemplateEnvironment[] = [];
	for (const item of value) {
		if (
			!isRecord(item) ||
			typeof item.name !== "string" ||
			typeof item.description !== "string" ||
			!ENV_NAME.test(item.name) ||
			!SINGLE_LINE.test(item.description)
		) {
			return undefined;
		}
		result.push({ name: item.name, description: item.description });
	}
	return result;
};

export const parseTemplateOperations = (
	value: unknown,
	layout: TemplateLayout,
): FunctionTemplateOperation[] | undefined => {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	if (value.length > MAX_OPERATIONS) return undefined;
	const operations: FunctionTemplateOperation[] = [];
	const ids = new Set<string>();
	const routes = new Set<string>();
	const slugs = new Set<string>();
	const sources = new Set<string>();
	let recommended = 0;
	for (const item of value) {
		if (
			!isRecord(item) ||
			!matches(item.id, OPERATION_ID) ||
			ids.has(item.id) ||
			!isText(item.title) ||
			!isText(item.description) ||
			typeof item.source !== "string" ||
			!isSafeSourcePath(item.source) ||
			sources.has(item.source) ||
			!isOptionalString(item.route) ||
			typeof item.recommended !== "boolean"
		) {
			return undefined;
		}
		const operation: FunctionTemplateOperation = {
			id: item.id,
			title: item.title,
			description: item.description,
			source: item.source,
			recommended: item.recommended,
		};
		if (layout === "separate") {
			if (
				typeof item.slug !== "string" ||
				!OPERATION_SLUG.test(item.slug) ||
				slugs.has(item.slug)
			) {
				return undefined;
			}
			slugs.add(item.slug);
			operation.slug = item.slug;
		} else {
			const route = item.route === undefined ? `/${item.id}` : item.route;
			if (!ROUTE_PATTERN.test(route) || routes.has(route)) {
				return undefined;
			}
			routes.add(route);
			operation.route = route;
		}
		if (item.recommended) recommended++;
		ids.add(item.id);
		sources.add(item.source);
		operations.push(operation);
	}
	if (recommended < 1) return undefined;
	return operations;
};

export const recommendedOperations = (
	operations: readonly FunctionTemplateOperation[],
): FunctionTemplateOperation[] =>
	operations.filter((operation) => operation.recommended);

export const resolveOperationById = (
	operations: readonly FunctionTemplateOperation[],
	id: string,
): FunctionTemplateOperation => {
	const operation = operations.find((candidate) => candidate.id === id);
	if (!operation) {
		throw new Error(
			`Unknown operation "${id}". Available operations: ${operations
				.map((candidate) => candidate.id)
				.join(", ")}.`,
		);
	}
	return operation;
};

export const parseTemplateItem = (
	text: string,
	expectedId?: string,
): FunctionTemplate => {
	const data: unknown = JSON.parse(text);
	if (!isRecord(data)) {
		throw new Error("Invalid template.json: expected a JSON object.");
	}
	if (
		!matches(data.id, TEMPLATE_ID) ||
		(expectedId !== undefined && data.id !== expectedId)
	) {
		throw new Error("Invalid template.json: bad or mismatched id.");
	}
	if (!isText(data.title) || !isText(data.description)) {
		throw new Error(
			`Invalid template.json for "${data.id}": missing title or description.`,
		);
	}
	if (!isOptionalString(data.provider)) {
		throw new Error(
			`Invalid template.json for "${data.id}": provider must be a string.`,
		);
	}
	if (
		typeof data.layout !== "string" ||
		!(TEMPLATE_LAYOUTS as readonly string[]).includes(data.layout)
	) {
		throw new Error(
			`Invalid template.json for "${data.id}": layout must be one of ${TEMPLATE_LAYOUTS.join(", ")}.`,
		);
	}
	const layout = data.layout as TemplateLayout;
	const dependencies = stringList(data.dependencies ?? []);
	if (
		dependencies === undefined ||
		!dependencies.every((dependency) => EXACT_DEPENDENCY.test(dependency))
	) {
		throw new Error(
			`Invalid template.json for "${data.id}": dependencies must be exact name@version pins.`,
		);
	}
	const environment = parseEnvironment(data.environment ?? []);
	if (environment === undefined) {
		throw new Error(
			`Invalid template.json for "${data.id}": environment names must be UPPER_SNAKE with a one-line description.`,
		);
	}
	let operations: FunctionTemplateOperation[] | undefined;
	if (data.operations !== undefined) {
		operations = parseTemplateOperations(data.operations, layout);
		if (operations === undefined) {
			throw new Error(
				`Invalid template.json for "${data.id}": malformed operations.`,
			);
		}
	}
	return {
		id: data.id,
		...(data.provider ? { provider: data.provider } : {}),
		title: data.title,
		description: data.description,
		layout,
		dependencies,
		environment,
		...(operations ? { operations } : {}),
	};
};

export const parseRegistryIndex = (text: string): RegistryIndexEntry[] => {
	const data: unknown = JSON.parse(text);
	const items = isRecord(data) ? data.templates : undefined;
	if (!Array.isArray(items)) {
		throw new Error(
			'Invalid function registry: missing "templates" array.',
		);
	}
	if (items.length > MAX_INDEX_ENTRIES) {
		throw new Error(
			`Invalid function registry: ${items.length} templates, more than the ${MAX_INDEX_ENTRIES} the CLI reads.`,
		);
	}
	const entries: RegistryIndexEntry[] = [];
	const seen = new Set<string>();
	for (const [index, item] of items.entries()) {
		const at = `templates[${index}]${
			isRecord(item) && typeof item.id === "string"
				? ` ("${item.id}")`
				: ""
		}`;
		const invalid = (reason: string) =>
			new Error(`Invalid function registry: ${at} ${reason}.`);
		if (!isRecord(item)) throw invalid("is not an object");
		if (!matches(item.id, TEMPLATE_ID)) throw invalid("has a bad id");
		if (seen.has(item.id)) throw invalid("repeats an id");
		if (!isText(item.title) || !isText(item.description)) {
			throw invalid("is missing a title or description");
		}
		if (!isOptionalString(item.provider)) {
			throw invalid("has a provider that is not a string");
		}
		if (
			typeof item.path !== "string" ||
			!isContainedRelativePath(item.path)
		) {
			throw invalid("has a missing or unsafe path");
		}
		if (
			item.logo !== undefined &&
			(typeof item.logo !== "string" || !isDisplayLogoUrl(item.logo))
		) {
			throw invalid("has a logo that is not an https:// URL");
		}
		seen.add(item.id);
		entries.push({
			id: item.id,
			...(item.provider ? { provider: item.provider } : {}),
			title: item.title,
			description: item.description,
			path: item.path,
			...(item.logo ? { logo: item.logo } : {}),
		});
	}
	return entries;
};
