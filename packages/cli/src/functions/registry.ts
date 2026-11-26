import { didYouMean, REDACTED_INVALID_VALUE } from "../errors.js";

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

/**
 * A Function Trigger the CLI declares in `neon.ts` next to the scaffolded function. `operation`
 * names the operation whose function it calls; the trigger is declared only when that operation
 * is scaffolded. A router operation's trigger always posts to the operation's route.
 */
export type FunctionTemplateTrigger = {
	name: string;
	operation?: string;
	path?: string;
} & (
	| { type: "schedule"; cron: string }
	| { type: "storage_object_created"; bucket: string; prefix?: string }
);

export type FunctionTemplate = {
	id: string;
	provider?: string;
	title: string;
	description: string;
	layout: TemplateLayout;
	dependencies: string[];
	environment: FunctionTemplateEnvironment[];
	operations?: FunctionTemplateOperation[];
	triggers: FunctionTemplateTrigger[];
};

export const GITHUB_OWNER_PATTERN =
	"^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$";
export const GITHUB_REPO_PATTERN = "^(?!\\.\\.?$)[A-Za-z0-9._-]{1,100}$";
export const GITHUB_REF_PATTERN = "^[A-Za-z0-9._/+-]{1,255}$";
export const DEFAULT_GITHUB_REF = "HEAD";

export const remoteSourceJsonSchema = {
	type: "object",
	minProperties: 1,
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
		properties.source = remoteSourceJsonSchema;
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
	"dependencies" | "environment" | "triggers"
> & {
	dependencies?: string[];
	environment?: FunctionTemplateEnvironment[];
	triggers?: unknown;
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
		const ids = operations.map((candidate) => candidate.id);
		throw new Error(
			`Unknown operation ${REDACTED_INVALID_VALUE}.${didYouMean([id], ids)} Available operations: ${ids.join(", ")}.`,
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
		if (!isRecord(source) || Object.keys(source).length === 0) {
			throw new Error(
				`Invalid function registry: ${at} has an invalid source.`,
			);
		}
		if (!isGithubSourceDocument(source)) {
			return { ...entry, unsupportedSource: true };
		}
		const invalid = invalidGithubField(source.github);
		if (invalid) {
			throw new Error(
				`Invalid function registry: ${at} has an invalid source.${invalid}.`,
			);
		}
		const github = source.github as GithubSourceDocument;
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
	source: Record<string, unknown>,
): source is { github: Record<string, unknown> } =>
	Object.keys(source).join() === "github" &&
	(!isRecord(source.github) ||
		Object.keys(source.github).every((key) => GITHUB_SOURCE_KEYS.has(key)));

const matches = (pattern: string, value: unknown) =>
	typeof value === "string" && new RegExp(pattern).test(value);

const optionalPath = (value: unknown, pattern?: string) =>
	value === undefined ||
	(typeof value === "string" &&
		(pattern === undefined || matches(pattern, value)) &&
		isContainedRelativePath(value));

const invalidGithubField = (github: unknown): string | undefined => {
	if (!isRecord(github)) return "github";
	if (!matches(GITHUB_OWNER_PATTERN, github.owner)) return "github.owner";
	if (!matches(GITHUB_REPO_PATTERN, github.repo)) return "github.repo";
	if (!optionalPath(github.ref, GITHUB_REF_PATTERN)) return "github.ref";
	if (!optionalPath(github.dir)) return "github.dir";
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
		triggers: parseTriggers(data, operations ?? []),
	};
};

const TRIGGER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CRON_PATTERN = /^[0-9*,/-]+(?: [0-9*,/-]+){4}$/;
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const FUNCTION_PATH_PATTERN = /^\/[A-Za-z0-9\-._~/]*$/;
const MAX_PREFIX_LENGTH = 1024;
const TRIGGER_KEYS: Record<FunctionTemplateTrigger["type"], Set<string>> = {
	schedule: new Set(["name", "type", "cron", "operation", "path"]),
	storage_object_created: new Set([
		"name",
		"type",
		"bucket",
		"prefix",
		"operation",
		"path",
	]),
};

/**
 * The CLI writes these values into the project's `neon.ts`, so it checks them itself instead of
 * trusting that the published schema rejected anything unsafe.
 */
const parseTriggers = (
	data: TemplateDocument,
	operations: readonly FunctionTemplateOperation[],
): FunctionTemplateTrigger[] => {
	if (data.triggers === undefined) return [];
	const invalid = (index: number, reason: string): never => {
		throw new Error(
			`Invalid template.json for "${data.id}": triggers[${index}] ${reason}.`,
		);
	};
	if (!Array.isArray(data.triggers)) {
		throw new Error(
			`Invalid template.json for "${data.id}": triggers must be an array.`,
		);
	}
	const names = new Set<string>();
	return data.triggers.map(
		(item: unknown, index): FunctionTemplateTrigger => {
			if (!isRecord(item)) return invalid(index, "is not an object");
			const { name, type, operation, path } = item;
			if (type !== "schedule" && type !== "storage_object_created") {
				return invalid(
					index,
					'has a type other than "schedule" or "storage_object_created"',
				);
			}
			const unknown = Object.keys(item).find(
				(key) => !TRIGGER_KEYS[type].has(key),
			);
			if (unknown !== undefined) {
				return invalid(
					index,
					`has a field ${type} triggers do not take`,
				);
			}
			if (typeof name !== "string" || !TRIGGER_NAME_PATTERN.test(name)) {
				return invalid(
					index,
					"needs a name of 1-63 lowercase letters, digits, and hyphens",
				);
			}
			if (names.has(name)) return invalid(index, "repeats a name");
			names.add(name);
			if (
				path !== undefined &&
				(typeof path !== "string" || !FUNCTION_PATH_PATTERN.test(path))
			) {
				return invalid(
					index,
					"has a path that is not a URL path starting with /",
				);
			}
			if (operation === undefined) {
				if (operations.length > 0) {
					return invalid(index, "needs the operation it calls");
				}
			} else {
				if (operations.length === 0) {
					return invalid(
						index,
						"sets an operation, but the template has no operations",
					);
				}
				if (typeof operation !== "string") {
					return invalid(
						index,
						"has an operation that is not a string",
					);
				}
				if (!operations.some(({ id }) => id === operation)) {
					return invalid(
						index,
						"names an operation the template lacks",
					);
				}
				if (data.layout === "router" && path !== undefined) {
					return invalid(
						index,
						"sets a path, but a router trigger posts to its operation's route",
					);
				}
			}
			const target = {
				name,
				...(operation === undefined ? {} : { operation }),
				...(path === undefined ? {} : { path }),
			};
			if (type === "schedule") {
				const { cron } = item;
				if (typeof cron !== "string" || !CRON_PATTERN.test(cron)) {
					return invalid(
						index,
						"needs a numeric five-field cron expression separated by single spaces",
					);
				}
				return { ...target, type, cron };
			}
			const { bucket, prefix } = item;
			if (
				typeof bucket !== "string" ||
				!BUCKET_NAME_PATTERN.test(bucket)
			) {
				return invalid(
					index,
					"needs a bucket name of 3-63 lowercase letters, digits, dots, and hyphens",
				);
			}
			if (
				prefix !== undefined &&
				(typeof prefix !== "string" ||
					prefix === "" ||
					prefix.length > MAX_PREFIX_LENGTH)
			) {
				return invalid(index, "needs a prefix of 1-1024 characters");
			}
			return {
				...target,
				type,
				bucket,
				...(prefix === undefined ? {} : { prefix }),
			};
		},
	);
};
