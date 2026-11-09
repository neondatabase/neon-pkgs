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

export const GITHUB_OWNER_PATTERN =
	"^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$";
export const GITHUB_REPO_PATTERN = "^(?!\\.\\.?$)[A-Za-z0-9._-]{1,100}$";
export const GITHUB_REF_PATTERN = "^[A-Za-z0-9._/+-]{1,255}$";
export const DEFAULT_GITHUB_REF = "HEAD";

export const githubSourceJsonSchema = {
	type: "object",
	additionalProperties: false,
	required: ["github"],
	properties: {
		github: {
			type: "object",
			additionalProperties: false,
			required: ["owner", "repo"],
			properties: {
				owner: { type: "string", pattern: GITHUB_OWNER_PATTERN },
				repo: { type: "string", pattern: GITHUB_REPO_PATTERN },
				ref: { type: "string", pattern: GITHUB_REF_PATTERN },
				dir: {
					type: "string",
					minLength: 1,
					maxLength: MAX_PATH_LENGTH,
				},
			},
		},
	},
} as const;

export type GithubTemplateSource = {
	owner: string;
	repo: string;
	ref: string;
	dir?: string;
};

export type TemplateRemoteSource = {
	github: GithubTemplateSource;
};

export type RegistryIndexEntry = {
	id: string;
	provider?: string;
	title: string;
	description: string;
	path?: string;
	logo?: string;
	website?: string;
	source?: TemplateRemoteSource;
	unsupportedSource?: true;
};

export const allowGithubTemplateSources = (schema: object): object => {
	const clone = structuredClone(schema) as {
		properties?: {
			templates?: { items?: { properties?: Record<string, unknown> } };
		};
	};
	const properties = clone.properties?.templates?.items?.properties;
	if (properties && properties.source === undefined) {
		properties.source = githubSourceJsonSchema;
	}
	return clone;
};

export type SchemaValidate<T> = {
	check(data: unknown): data is T;
	errorsText(): string;
};

export type RegistryIndexDocument = {
	templates: Array<
		Omit<RegistryIndexEntry, "path" | "source" | "unsupportedSource"> & {
			path: string;
			source?: unknown;
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
		const { source, ...entry } = item;
		if (source === undefined) return entry;
		if (!isGithubSourceDocument(source)) {
			return { ...entry, unsupportedSource: true };
		}
		const { github } = source;
		const invalid = invalidGithubField(github);
		if (invalid) {
			throw new Error(
				`Invalid function registry: ${at} has an invalid source.github.${invalid}.`,
			);
		}
		return {
			...entry,
			source: {
				github: { ...github, ref: github.ref ?? DEFAULT_GITHUB_REF },
			},
		};
	});
};

type GithubSourceDocument = Omit<GithubTemplateSource, "ref"> & {
	ref?: string;
};

const GITHUB_SOURCE_KEYS = new Set(["owner", "repo", "ref", "dir"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isGithubSourceDocument = (
	source: unknown,
): source is { github: GithubSourceDocument } => {
	if (!isRecord(source) || Object.keys(source).join() !== "github") {
		return false;
	}
	const { github } = source;
	return (
		isRecord(github) &&
		Object.entries(github).every(
			([key, value]) =>
				GITHUB_SOURCE_KEYS.has(key) && typeof value === "string",
		) &&
		github.owner !== undefined &&
		github.repo !== undefined
	);
};

const matches = (pattern: string, value: string) =>
	new RegExp(pattern).test(value);

const invalidGithubField = (
	github: GithubSourceDocument,
): keyof GithubSourceDocument | undefined => {
	if (!matches(GITHUB_OWNER_PATTERN, github.owner)) return "owner";
	if (!matches(GITHUB_REPO_PATTERN, github.repo)) return "repo";
	if (
		github.ref !== undefined &&
		!(
			matches(GITHUB_REF_PATTERN, github.ref) &&
			isContainedRelativePath(github.ref)
		)
	) {
		return "ref";
	}
	if (github.dir !== undefined && !isContainedRelativePath(github.dir)) {
		return "dir";
	}
	return undefined;
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
