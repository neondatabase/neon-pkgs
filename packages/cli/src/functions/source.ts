import { readFileSync, realpathSync, statSync } from "node:fs";
import { posix, resolve, sep } from "node:path";
import {
	type FunctionTemplate,
	isContainedRelativePath,
	MAX_FILE_BYTES,
	MAX_JSON_BYTES,
	MAX_TOTAL_BYTES,
	parseRegistryIndex,
	parseTemplateItem,
	type RegistryIndexDocument,
	type RegistryIndexEntry,
	type SchemaValidate,
	type TemplateDocument,
} from "./registry.js";

export const DEFAULT_REGISTRY_URL =
	"https://neon.com/functions/registry/registry.json";
export const GITHUB_REGISTRY_URL =
	"https://raw.githubusercontent.com/neondatabase/examples/main/registry/registry.json";

export const REGISTRY_DIR_ENV = "NEON_FUNCTION_REGISTRY_DIR";
export const REGISTRY_URL_ENV = "NEON_FUNCTION_REGISTRY_URL";

const REGISTRY_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type RegistrySource =
	| { kind: "dir"; dir: string }
	| { kind: "url"; url: URL };

export class RegistryError extends Error {
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.name = "RegistryError";
		if (status !== undefined) this.status = status;
	}
}

export const resolveRegistrySource = (
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
	defaultUrl: string = DEFAULT_REGISTRY_URL,
): RegistrySource => {
	const dir = env[REGISTRY_DIR_ENV];
	if (dir) return { kind: "dir", dir: resolve(cwd, dir) };
	const raw = env[REGISTRY_URL_ENV] || defaultUrl;
	if (!URL.canParse(raw)) {
		throw new RegistryError(`${REGISTRY_URL_ENV} is not a URL: ${raw}`);
	}
	const url = new URL(raw);
	if (
		url.protocol !== "https:" &&
		!(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
	) {
		throw new RegistryError(
			`${REGISTRY_URL_ENV} must be an https:// URL, got ${raw}`,
		);
	}
	return { kind: "url", url };
};

export const describeRegistrySource = (source: RegistrySource): string =>
	source.kind === "dir" ? source.dir : source.url.href;

type ReadText = (relativePath: string, limit: number) => Promise<string>;

const tooLarge = (path: string, limit: number) =>
	new RegistryError(
		`Registry file ${path} is larger than the ${limit}-byte limit.`,
	);

const dirReader = (dir: string): ReadText => {
	let root: string;
	return async (relativePath, limit) => {
		try {
			root ??= realpathSync(dir);
		} catch {
			throw new RegistryError(
				`${REGISTRY_DIR_ENV} points at ${dir}, which does not exist.`,
			);
		}
		let path: string;
		try {
			path = realpathSync(resolve(root, relativePath));
		} catch {
			throw new RegistryError(
				`Registry file ${relativePath} not found in ${dir}.`,
			);
		}
		if (!path.startsWith(root + sep)) {
			throw new RegistryError(
				`Registry file ${relativePath} resolves outside ${dir}.`,
			);
		}
		if (statSync(path).size > limit) throw tooLarge(relativePath, limit);
		return readFileSync(path, "utf8");
	};
};

const urlReader = (index: URL): ReadText => {
	const base = new URL(".", index);
	return async (relativePath, limit) => {
		const url = new URL(relativePath, base);
		if (
			url.origin !== base.origin ||
			!url.pathname.startsWith(base.pathname)
		) {
			throw new RegistryError(
				`Registry file ${relativePath} resolves outside ${base.href}.`,
			);
		}
		let response: Response;
		try {
			response = await fetch(url, {
				redirect: "error",
				signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
			});
		} catch {
			throw new RegistryError(
				`Could not reach the Function Registry at ${url.href}. Check your connection, or set ${REGISTRY_DIR_ENV} to a local copy.`,
			);
		}
		if (!response.ok) {
			throw new RegistryError(
				`The Function Registry answered ${response.status} for ${url.href}.`,
				response.status,
			);
		}
		const declared = Number(response.headers.get("content-length"));
		if (declared > limit) throw tooLarge(relativePath, limit);
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > limit) {
			throw tooLarge(relativePath, limit);
		}
		return text;
	};
};

export type LoadedTemplate = {
	template: FunctionTemplate;
	sources: Map<string, string>;
};

export type Registry = {
	source: RegistrySource;
	entries: RegistryIndexEntry[];
	load: (entry: RegistryIndexEntry) => Promise<LoadedTemplate>;
};

export const templateSourcePaths = (template: FunctionTemplate): string[] =>
	template.operations?.map((operation) => operation.source) ?? [
		"functions/index.ts",
	];

const INDEX_FILE = "registry.json";
const REGISTRY_SCHEMA_FILE = "schemas/registry.schema.json";
const TEMPLATE_SCHEMA_FILE = "schemas/template.schema.json";

type CompiledSchemas = {
	registry: SchemaValidate<RegistryIndexDocument>;
	template: SchemaValidate<TemplateDocument>;
};

let publishedSchemas: Promise<CompiledSchemas> | undefined;

const compileSchemas = async (
	registrySchema: object,
	templateSchema: object,
): Promise<CompiledSchemas> => {
	const [{ default: Ajv2020 }, { default: addFormats }] = await Promise.all([
		import("ajv/dist/2020.js"),
		import("ajv-formats"),
	]);
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	addFormats(ajv);
	const wrap = <T>(schema: object): SchemaValidate<T> => {
		const check = ajv.compile<T>(schema);
		return {
			check: (data: unknown): data is T => check(data),
			errorsText: () => ajv.errorsText(check.errors),
		};
	};
	return {
		registry: wrap<RegistryIndexDocument>(registrySchema),
		template: wrap<TemplateDocument>(templateSchema),
	};
};

const readPublishedSchemas = async (
	index: string,
): Promise<CompiledSchemas> => {
	const read = urlReader(new URL(index));
	const registrySchema: unknown = JSON.parse(
		await read(REGISTRY_SCHEMA_FILE, MAX_JSON_BYTES),
	);
	const templateSchema: unknown = JSON.parse(
		await read(TEMPLATE_SCHEMA_FILE, MAX_JSON_BYTES),
	);
	if (
		typeof registrySchema !== "object" ||
		registrySchema === null ||
		typeof templateSchema !== "object" ||
		templateSchema === null
	) {
		throw new RegistryError(
			"Published Function Registry schemas were not JSON objects.",
		);
	}
	return compileSchemas(registrySchema, templateSchema);
};

const loadPublishedSchemas = (): Promise<CompiledSchemas> => {
	publishedSchemas ??= readPublishedSchemas(DEFAULT_REGISTRY_URL)
		.catch(async (error) => {
			if (!(error instanceof RegistryError)) throw error;
			return readPublishedSchemas(GITHUB_REGISTRY_URL);
		})
		.catch((error) => {
			publishedSchemas = undefined;
			throw error;
		});
	return publishedSchemas;
};

export type RegistryDefaults = {
	primary?: string;
	fallback?: string;
	env?: NodeJS.ProcessEnv;
};

export const openRegistry = async (
	source?: RegistrySource,
	{
		primary = DEFAULT_REGISTRY_URL,
		fallback = GITHUB_REGISTRY_URL,
		env = process.env,
	}: RegistryDefaults = {},
): Promise<Registry> => {
	if (source) return openRegistryAt(source);
	const resolved = resolveRegistrySource(env, process.cwd(), primary);
	if (
		resolved.kind !== "url" ||
		resolved.url.href !== new URL(primary).href
	) {
		return openRegistryAt(resolved);
	}
	const github: RegistrySource = { kind: "url", url: new URL(fallback) };
	try {
		return await openRegistryAt(resolved, github);
	} catch (error) {
		if (!(error instanceof RegistryError)) throw error;
		return openRegistryAt(github);
	}
};

const readerFor = (source: RegistrySource): ReadText =>
	source.kind === "dir" ? dirReader(source.dir) : urlReader(source.url);

const withStaleIndexHint =
	(read: ReadText, index: RegistrySource, files: RegistrySource): ReadText =>
	async (path, limit) => {
		try {
			return await read(path, limit);
		} catch (error) {
			if (!(error instanceof RegistryError) || error.status !== 404) {
				throw error;
			}
			throw new RegistryError(
				`${error.message} The index from ${describeRegistrySource(index)} is cached and may still list a template that moved or was removed. Try again in a few minutes, or set ${REGISTRY_URL_ENV}=${describeRegistrySource(files)} to read the current index.`,
				404,
			);
		}
	};

const openRegistryAt = async (
	source: RegistrySource,
	files: RegistrySource = source,
): Promise<Registry> => {
	const read = readerFor(source);
	const readFile =
		files === source
			? read
			: withStaleIndexHint(readerFor(files), source, files);
	const indexPath =
		source.kind === "dir"
			? INDEX_FILE
			: posix.basename(source.url.pathname);
	const schemas = await loadPublishedSchemas();
	const parse = <T>(path: string, text: string, fn: (text: string) => T) => {
		try {
			return fn(text);
		} catch (error) {
			throw new RegistryError(
				`Invalid registry file ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
	const entries = parse(
		indexPath,
		await read(indexPath, MAX_JSON_BYTES),
		(text) => parseRegistryIndex(text, schemas.registry),
	);

	const load = async (entry: RegistryIndexEntry): Promise<LoadedTemplate> => {
		if (!entry.path || !isContainedRelativePath(entry.path)) {
			throw new RegistryError(
				`Template "${entry.id}" has no valid path.`,
			);
		}
		const template = parse(
			entry.path,
			await readFile(entry.path, MAX_JSON_BYTES),
			(text) => parseTemplateItem(text, schemas.template, entry.id),
		);
		const dir = posix.dirname(entry.path);
		const sources = new Map<string, string>();
		let total = 0;
		for (const path of templateSourcePaths(template)) {
			if (!isContainedRelativePath(path)) {
				throw new RegistryError(
					`Template "${entry.id}" references an unsafe path: ${path}`,
				);
			}
			const text = await readFile(
				dir === "." ? path : posix.join(dir, path),
				Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total),
			);
			total += Buffer.byteLength(text, "utf8");
			sources.set(path, text);
		}
		return { template, sources };
	};

	return { source, entries, load };
};
