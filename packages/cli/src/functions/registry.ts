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

export type SchemaValidate<T> = {
	check(data: unknown): data is T;
	errorsText(): string;
};

export type RegistryIndexDocument = {
	templates: Array<
		Omit<RegistryIndexEntry, "path"> & {
			path: string;
		}
	>;
};

export type TemplateDocument = Omit<
	FunctionTemplate,
	"dependencies" | "environment"
> & {
	dependencies?: string[];
	environment?: FunctionTemplateEnvironment[];
};

function assertValid<T>(
	validate: SchemaValidate<T>,
	data: unknown,
	label: string,
): asserts data is T {
	if (!validate.check(data)) {
		throw new Error(`${label}: ${validate.errorsText()}`);
	}
}

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
	validate: SchemaValidate<RegistryIndexDocument>,
): RegistryIndexEntry[] => {
	const data: unknown = JSON.parse(text);
	assertValid(validate, data, "Invalid function registry");
	const seen = new Set<string>();
	return data.templates.map((item, index) => {
		const at = `templates[${index}] ("${item.id}")`;
		if (seen.has(item.id)) {
			throw new Error(`Invalid function registry: ${at} repeats an id.`);
		}
		if (!isContainedRelativePath(item.path)) {
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
	validate: SchemaValidate<TemplateDocument>,
	expectedId?: string,
): FunctionTemplate => {
	const data: unknown = JSON.parse(text);
	assertValid(validate, data, "Invalid template.json");
	if (expectedId !== undefined && data.id !== expectedId) {
		throw new Error("Invalid template.json: bad or mismatched id.");
	}
	const operations = data.operations?.map((operation) => {
		if (!isContainedRelativePath(operation.source)) {
			throw new Error(
				`Invalid template.json for "${data.id}": malformed operations.`,
			);
		}
		return data.layout === "separate"
			? operation
			: { ...operation, route: operation.route ?? `/${operation.id}` };
	});
	return {
		id: data.id,
		...(data.provider ? { provider: data.provider } : {}),
		title: data.title,
		description: data.description,
		layout: data.layout,
		dependencies: data.dependencies ?? [],
		environment: data.environment ?? [],
		...(operations ? { operations } : {}),
	};
};
