import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fetchCatalog } from "../templates/catalog.js";
import { TemplateDownloadError } from "../templates/github.js";
import { BASIC_TEMPLATE } from "./basic.js";
import { RESEND_TEMPLATE } from "./resend.js";
import { REST_API_TEMPLATE } from "./rest-api.js";

const MAX_PATH_LENGTH = 255;
const MAX_INDEX_ENTRIES = 500;
const MAX_OPERATIONS = 40;
const MAX_LOGO_URL_LENGTH = 2048;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_JSON_BYTES = 1 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]*$/;
const OPERATION_ID = /^[a-z0-9][a-z0-9-]*$/;
const OPERATION_SLUG = /^[a-z0-9]{1,20}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:/;
const SOURCE_EXTENSION = /\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;
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
	/** Router layout only: the URL path the generated router dispatches to. */
	route?: string;
	/** Separate layout only: the Neon deployment slug this operation registers under. */
	slug?: string;
	recommended: boolean;
};

export type FunctionTemplate = {
	id: string;
	provider?: string;
	title: string;
	description: string;
	/** `router` generates one aggregate function; `separate` deploys each operation on its own. */
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

export type LoadedTemplate = {
	template: FunctionTemplate;
	loadSource: (relativePath: string) => Promise<string>;
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
			!ENV_NAME.test(item.name)
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
			typeof item.id !== "string" ||
			!OPERATION_ID.test(item.id) ||
			ids.has(item.id) ||
			typeof item.title !== "string" ||
			item.title.trim() === "" ||
			typeof item.description !== "string" ||
			item.description.trim() === "" ||
			typeof item.source !== "string" ||
			!isSafeSourcePath(item.source) ||
			sources.has(item.source) ||
			(item.route !== undefined && typeof item.route !== "string") ||
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
			// Separate operations deploy independently, so each names its own
			// Neon slug; routes are meaningless without a router.
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
		typeof data.id !== "string" ||
		!TEMPLATE_ID.test(data.id) ||
		(expectedId !== undefined && data.id !== expectedId)
	) {
		throw new Error("Invalid template.json: bad or mismatched id.");
	}
	if (
		typeof data.title !== "string" ||
		data.title.trim() === "" ||
		typeof data.description !== "string" ||
		data.description.trim() === ""
	) {
		throw new Error(
			`Invalid template.json for "${data.id}": missing title or description.`,
		);
	}
	if (data.provider !== undefined && typeof data.provider !== "string") {
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
			`Invalid template.json for "${data.id}": environment names must be UPPER_SNAKE with a description.`,
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
	const entries: RegistryIndexEntry[] = [];
	const seen = new Set<string>();
	for (const item of items.slice(0, MAX_INDEX_ENTRIES)) {
		if (
			!isRecord(item) ||
			typeof item.id !== "string" ||
			!TEMPLATE_ID.test(item.id) ||
			seen.has(item.id) ||
			typeof item.title !== "string" ||
			item.title.trim() === "" ||
			typeof item.description !== "string" ||
			item.description.trim() === "" ||
			(item.provider !== undefined &&
				typeof item.provider !== "string") ||
			typeof item.path !== "string" ||
			!isContainedRelativePath(item.path) ||
			(item.logo !== undefined &&
				(typeof item.logo !== "string" || !isDisplayLogoUrl(item.logo)))
		) {
			continue;
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

export type BuiltinTemplate = {
	template: FunctionTemplate;
	sources: Record<string, string>;
};

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
	BASIC_TEMPLATE,
	RESEND_TEMPLATE,
	REST_API_TEMPLATE,
];

const builtinById = (id: string): BuiltinTemplate | undefined =>
	BUILTIN_TEMPLATES.find((builtin) => builtin.template.id === id);

export const isBuiltinTemplate = (id: string): boolean =>
	builtinById(id) !== undefined;

export const builtinIndexEntries = (): RegistryIndexEntry[] =>
	BUILTIN_TEMPLATES.map(({ template }) => ({
		id: template.id,
		...(template.provider ? { provider: template.provider } : {}),
		title: template.title,
		description: template.description,
	}));

const DEFAULT_INDEX_URLS = [
	// Hackathon handoff: the reviewed catalog currently lives in Jeff's
	// GitHub Pages site (neondatabase/function-examples). The neon.com and
	// neonsolutions origins remain as fallbacks for when it moves in-house.
	"https://jeff-at-neon.github.io/function-examples/registry.json",
	"https://neon.com/functions/registry.json",
	"https://raw.githubusercontent.com/neonsolutions/registry/main/registry.json",
];
const ALLOWED_REGISTRY_HOSTS = [
	"jeff-at-neon.github.io",
	"neon.com",
	"raw.githubusercontent.com",
];

type RegistrySource =
	| { kind: "dir"; dir: string }
	| { kind: "http"; indexUrls: string[]; allowedHosts: Set<string> };

const resolveRegistrySource = (): RegistrySource => {
	const dir = process.env.NEON_FUNCTION_REGISTRY_DIR;
	if (dir) return { kind: "dir", dir };
	const override = process.env.NEON_FUNCTION_REGISTRY_URL;
	const indexUrls = override ? [override] : [...DEFAULT_INDEX_URLS];
	const allowedHosts = new Set(ALLOWED_REGISTRY_HOSTS);
	if (override && URL.canParse(override)) {
		allowedHosts.add(new URL(override).hostname);
	}
	return { kind: "http", indexUrls, allowedHosts };
};

const posixDirname = (value: string): string => {
	const index = value.lastIndexOf("/");
	return index === -1 ? "" : value.slice(0, index);
};

const dirUrl = (url: string): string => {
	const parsed = new URL(url);
	parsed.search = "";
	parsed.hash = "";
	parsed.pathname = parsed.pathname.replace(/[^/]*$/, "");
	return parsed.toString();
};

const resolveContainedUrl = (baseDir: string, relativePath: string): URL => {
	if (!isContainedRelativePath(relativePath)) {
		throw new Error(
			`Registry path "${relativePath}" is not a safe relative path.`,
		);
	}
	const base = new URL(baseDir);
	const resolved = new URL(relativePath, base);
	if (
		resolved.origin !== base.origin ||
		!resolved.pathname.startsWith(base.pathname)
	) {
		throw new Error(
			`Registry path "${relativePath}" escapes the registry base "${baseDir}".`,
		);
	}
	return resolved;
};

const assertAllowedHost = (url: URL, allowedHosts: Set<string>): void => {
	if (url.protocol !== "https:" && url.hostname !== "127.0.0.1") {
		throw new Error(`Registry URL must be https: "${url.toString()}".`);
	}
	if (!allowedHosts.has(url.hostname)) {
		throw new Error(
			`Registry host "${url.hostname}" is not an allowed Neon registry origin.`,
		);
	}
};

const REGISTRY_TIMEOUT_MS = 10_000;

const fetchRegistryText = async (
	url: URL,
	allowedHosts: Set<string>,
	maxBytes: number,
	baseDir?: string,
): Promise<string> => {
	assertAllowedHost(url, allowedHosts);
	let response: Response;
	try {
		response = await fetch(url, {
			signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
		});
	} catch (error) {
		throw new TemplateDownloadError(url.toString(), error);
	}
	if (!response.ok) {
		throw new Error(
			`Registry returned HTTP ${response.status} for ${url.toString()}.`,
		);
	}
	const final = new URL(response.url || url.toString());
	assertAllowedHost(final, allowedHosts);
	if (
		baseDir !== undefined &&
		(final.origin !== new URL(baseDir).origin ||
			!final.pathname.startsWith(new URL(baseDir).pathname))
	) {
		throw new Error(
			`Registry redirect escaped the registry base "${baseDir}": ${final.toString()}.`,
		);
	}
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new Error(
			`Registry file ${url.toString()} exceeds the ${maxBytes}-byte limit.`,
		);
	}
	const text = await response.text();
	if (Buffer.byteLength(text, "utf8") > maxBytes) {
		throw new Error(
			`Registry file ${url.toString()} exceeds the ${maxBytes}-byte limit.`,
		);
	}
	return text;
};

const readContainedFile = (
	rootDir: string,
	...relativeParts: string[]
): string => {
	for (const part of relativeParts) {
		if (isAbsolute(part) || !isContainedRelativePath(part)) {
			throw new Error(
				`Registry path "${part}" is not a safe relative path.`,
			);
		}
	}
	const root = resolve(rootDir);
	const target = resolve(root, ...relativeParts);
	if (target !== root && !target.startsWith(root + sep)) {
		throw new Error(
			`Registry path escapes the registry directory: "${target}".`,
		);
	}
	const text = readFileSync(target, "utf8");
	if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
		throw new Error(
			`Registry file "${join(...relativeParts)}" exceeds the ${MAX_FILE_BYTES}-byte limit.`,
		);
	}
	return text;
};

export const fetchFunctionTemplates = async (): Promise<
	RegistryIndexEntry[]
> => {
	const source = resolveRegistrySource();
	const builtin = builtinIndexEntries();
	let remote: RegistryIndexEntry[] = [];
	if (source.kind === "dir") {
		try {
			remote = parseRegistryIndex(
				readContainedFile(source.dir, "registry.json"),
			);
		} catch {
			remote = [];
		}
	} else {
		remote = await fetchCatalog({
			urls: source.indexUrls,
			parse: parseRegistryIndex,
			fallback: [],
			timeoutMs: REGISTRY_TIMEOUT_MS,
			maxBytes: MAX_JSON_BYTES,
		});
	}
	// Remote/local-override entries win a same-id collision so registry updates
	// ship without a CLI release; bundled built-ins fill the gaps and are the
	// fallback when the whole registry is unreachable.
	const remoteIds = new Set(remote.map((entry) => entry.id));
	return [...remote, ...builtin.filter((entry) => !remoteIds.has(entry.id))];
};

const loadedBuiltin = (
	id: string,
	builtin: BuiltinTemplate,
): LoadedTemplate => ({
	template: builtin.template,
	loadSource: async (relativePath) => {
		const source = builtin.sources[relativePath];
		if (source === undefined) {
			throw new Error(
				`Built-in template "${id}" has no source for "${relativePath}".`,
			);
		}
		return source;
	},
});

const loadRemoteTemplate = async (
	id: string,
	itemPath: string,
): Promise<LoadedTemplate> => {
	const source = resolveRegistrySource();
	if (source.kind === "dir") {
		const template = parseTemplateItem(
			readContainedFile(source.dir, itemPath),
			id,
		);
		const itemFolder = posixDirname(itemPath);
		return {
			template,
			loadSource: async (relativePath) => {
				if (!isContainedRelativePath(relativePath)) {
					throw new Error(
						`Registry path "${relativePath}" is not a safe relative path.`,
					);
				}
				const relative =
					itemFolder === ""
						? relativePath
						: `${itemFolder}/${relativePath}`;
				return readContainedFile(source.dir, relative);
			},
		};
	}
	let lastError: unknown;
	for (const indexUrl of source.indexUrls) {
		const indexDir = dirUrl(indexUrl);
		let itemUrl: URL;
		try {
			itemUrl = resolveContainedUrl(indexDir, itemPath);
		} catch (error) {
			lastError = error;
			continue;
		}
		try {
			const template = parseTemplateItem(
				await fetchRegistryText(
					itemUrl,
					source.allowedHosts,
					MAX_JSON_BYTES,
					indexDir,
				),
				id,
			);
			const itemDir = dirUrl(itemUrl.toString());
			return {
				template,
				loadSource: async (relativePath) =>
					fetchRegistryText(
						resolveContainedUrl(itemDir, relativePath),
						source.allowedHosts,
						MAX_FILE_BYTES,
						itemDir,
					),
			};
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error(`Could not load template "${id}" from the Neon registry.`);
};

/**
 * Load a template, preferring a remote/local-override item (an entry with a
 * `path`) over a bundled built-in of the same id. On a per-item fetch failure
 * fall back to the bundled copy only when one exists; a remote-only template
 * surfaces the error.
 */
export const loadFunctionTemplate = async (
	id: string,
	registry: RegistryIndexEntry[],
): Promise<LoadedTemplate | undefined> => {
	const entry = registry.find((candidate) => candidate.id === id);
	const builtin = builtinById(id);
	if (entry?.path !== undefined) {
		try {
			return await loadRemoteTemplate(id, entry.path);
		} catch (error) {
			if (builtin) return loadedBuiltin(id, builtin);
			throw error;
		}
	}
	return builtin ? loadedBuiltin(id, builtin) : undefined;
};
