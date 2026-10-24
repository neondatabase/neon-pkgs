const MAX_PATH_LENGTH = 255;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_JSON_BYTES = 1 * 1024 * 1024;

const WINDOWS_ABSOLUTE = /^[A-Za-z]:/;

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
	website?: string;
};

export type SchemaValidate = {
	(data: unknown): boolean;
	errorsText(): string;
};

const assertValid = (
	validate: SchemaValidate,
	data: unknown,
	label: string,
): void => {
	if (!validate(data)) {
		throw new Error(`${label}: ${validate.errorsText()}`);
	}
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

export const parseRegistryIndex = (
	text: string,
	validate: SchemaValidate,
): RegistryIndexEntry[] => {
	const data: unknown = JSON.parse(text);
	assertValid(validate, data, "Invalid function registry");
	const items = (data as { templates: RegistryIndexEntry[] }).templates;
	const seen = new Set<string>();
	return items.map((item, index) => {
		const at = `templates[${index}] ("${item.id}")`;
		if (seen.has(item.id)) {
			throw new Error(`Invalid function registry: ${at} repeats an id.`);
		}
		if (!item.path || !isContainedRelativePath(item.path)) {
			throw new Error(
				`Invalid function registry: ${at} has a missing or unsafe path.`,
			);
		}
		seen.add(item.id);
		return item;
	});
};

export const parseTemplateItem = (
	text: string,
	validate: SchemaValidate,
	expectedId?: string,
): FunctionTemplate => {
	const data: unknown = JSON.parse(text);
	assertValid(validate, data, "Invalid template.json");
	const template = data as FunctionTemplate;
	if (expectedId !== undefined && template.id !== expectedId) {
		throw new Error("Invalid template.json: bad or mismatched id.");
	}
	template.dependencies ??= [];
	template.environment ??= [];
	if (template.operations) {
		for (const operation of template.operations) {
			if (!isContainedRelativePath(operation.source)) {
				throw new Error(
					`Invalid template.json for "${template.id}": malformed operations.`,
				);
			}
			if (template.layout !== "separate") {
				operation.route ??= `/${operation.id}`;
			}
		}
	}
	return template;
};
