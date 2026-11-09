import { readFileSync, realpathSync, statSync } from "node:fs";
import { posix, resolve, sep } from "node:path";
import type { TemplateFile } from "../init/bootstrap.js";
import {
	allowGithubTemplateSources,
	type FunctionTemplate,
	type GithubTemplateSource,
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

const INDEX_FILE = "registry.json";
export const DEFAULT_GITHUB_RAW_URL = "https://raw.githubusercontent.com";
export const NEON_REGISTRY_GITHUB: GithubTemplateSource = {
	owner: "neondatabase",
	repo: "registry",
	ref: "main",
};
export const EXAMPLES_GITHUB: GithubTemplateSource = {
	owner: "neondatabase",
	repo: "examples",
	ref: "main",
	dir: "registry",
};
const rawIndexUrl = ({ owner, repo, ref, dir }: GithubTemplateSource) =>
	[DEFAULT_GITHUB_RAW_URL, owner, repo, ref, dir, INDEX_FILE]
		.filter((part) => part !== undefined)
		.join("/");
export const DEFAULT_REGISTRY_URL =
	"https://neon.com/functions/registry/registry.json";
export const NEON_REGISTRY_URL = rawIndexUrl(NEON_REGISTRY_GITHUB);
export const GITHUB_REGISTRY_URL = rawIndexUrl(EXAMPLES_GITHUB);
const NEON_REPOS = [NEON_REGISTRY_GITHUB, EXAMPLES_GITHUB];

export const REGISTRY_DIR_ENV = "NEON_FUNCTION_REGISTRY_DIR";
export const REGISTRY_URL_ENV = "NEON_FUNCTION_REGISTRY_URL";
export const GITHUB_RAW_ENV = "NEON_FUNCTION_REGISTRY_GITHUB";

const REGISTRY_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DOT_SEGMENTS = new Set([".", ".."]);

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

const parseHttpsUrl = (raw: string, label: string): URL => {
	if (!URL.canParse(raw)) {
		throw new RegistryError(`${label} is not a URL: ${raw}`);
	}
	const url = new URL(raw);
	if (
		url.protocol !== "https:" &&
		!(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
	) {
		throw new RegistryError(`${label} must be an https:// URL, got ${raw}`);
	}
	return url;
};

export const resolveRegistrySource = (
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
	defaultUrl: string = DEFAULT_REGISTRY_URL,
): RegistrySource => {
	const dir = env[REGISTRY_DIR_ENV];
	if (dir) return { kind: "dir", dir: resolve(cwd, dir) };
	return {
		kind: "url",
		url: parseHttpsUrl(
			env[REGISTRY_URL_ENV] || defaultUrl,
			REGISTRY_URL_ENV,
		),
	};
};

export const resolveGithubRawBase = (
	env: NodeJS.ProcessEnv = process.env,
	override?: string,
): URL =>
	parseHttpsUrl(
		override || env[GITHUB_RAW_ENV] || DEFAULT_GITHUB_RAW_URL,
		GITHUB_RAW_ENV,
	);

export const describeRegistrySource = (source: RegistrySource): string =>
	source.kind === "dir" ? source.dir : source.url.href;

export const describeRegistrySources = (sources: RegistrySource[]): string =>
	sources.map(describeRegistrySource).join(" and ");

const describeGithub = (github: {
	owner: string;
	repo: string;
	ref: string;
}): string => `${github.owner}/${github.repo}@${github.ref}`;

export const githubFileUrl = (
	raw: URL,
	github: GithubTemplateSource,
	relativePath: string,
): URL => {
	const repoPath = github.dir
		? `${github.dir}/${relativePath}`
		: relativePath;
	if (
		!isContainedRelativePath(repoPath) ||
		!isContainedRelativePath(github.ref) ||
		[github.owner, github.repo].some((part) => DOT_SEGMENTS.has(part))
	) {
		throw new RegistryError(
			`Registry file ${relativePath} resolves outside ${describeGithub(github)}.`,
		);
	}
	const url = new URL(raw);
	url.pathname = [
		url.pathname.replace(/\/+$/, ""),
		...[github.owner, github.repo, github.ref, repoPath]
			.flatMap((part) => part.split("/"))
			.map(encodeURIComponent),
	].join("/");
	return url;
};

type ReadText = (relativePath: string, limit: number) => Promise<string>;

const tooLarge = (path: string, limit: number) =>
	new RegistryError(
		`Registry file ${path} is larger than the ${limit}-byte limit.`,
	);

type FetchOrigin = {
	name: string;
	unreachableHint: string;
	redirectHint?: string;
	rateLimitHint?: string;
};

const LOCAL_COPY_HINT = `Check your connection, or set ${REGISTRY_DIR_ENV} to a local copy.`;

const REGISTRY_ORIGIN: FetchOrigin = {
	name: "the Function Registry",
	unreachableHint: LOCAL_COPY_HINT,
};

const unreachable = (
	error: unknown,
	url: URL,
	origin: FetchOrigin,
): RegistryError => {
	if (error instanceof Error && error.name === "TimeoutError") {
		return new RegistryError(
			`${origin.name} did not answer ${url.href} within ${REGISTRY_TIMEOUT_MS / 1000} seconds. ${origin.unreachableHint}`,
		);
	}
	const cause =
		error instanceof Error && "cause" in error ? error.cause : undefined;
	if (cause instanceof Error && /redirect/i.test(cause.message)) {
		return new RegistryError(
			`${origin.name} redirected ${url.href}, and the CLI does not follow redirects.${origin.redirectHint ? ` ${origin.redirectHint}` : ""}`,
		);
	}
	return new RegistryError(
		`Could not reach ${origin.name} at ${url.href}. ${origin.unreachableHint}`,
	);
};

const fetchText = async (
	url: URL,
	relativePath: string,
	limit: number,
	origin: FetchOrigin,
): Promise<string> => {
	let response: Response;
	try {
		response = await fetch(url, {
			redirect: "error",
			headers: { "User-Agent": "neon" },
			signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
		});
	} catch (error) {
		throw unreachable(error, url, origin);
	}
	if (!response.ok) {
		const rateLimited = response.status === 403 || response.status === 429;
		const hint =
			rateLimited && origin.rateLimitHint
				? ` ${origin.rateLimitHint}`
				: "";
		throw new RegistryError(
			`Could not read ${url.href}: ${origin.name} answered ${response.status}.${hint}`,
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
		return fetchText(url, relativePath, limit, REGISTRY_ORIGIN);
	};
};

type GithubContext = { env: NodeJS.ProcessEnv; rawBase: () => URL };

const githubReader = (
	github: GithubTemplateSource,
	rawBase: () => URL,
	unreachableHint = "Check your connection.",
): ReadText => {
	const origin: FetchOrigin = {
		name: `GitHub (${describeGithub(github)})`,
		unreachableHint,
		redirectHint:
			"The repo may have been renamed or moved; its registry entry needs updating.",
		rateLimitHint:
			"GitHub is rate limiting this network; try again in a few minutes.",
	};
	return async (relativePath, limit) =>
		fetchText(
			githubFileUrl(rawBase(), github, relativePath),
			relativePath,
			limit,
			origin,
		);
};

const archiveReader = (
	github: GithubTemplateSource,
	{ env, rawBase }: GithubContext,
): ReadText => {
	const { owner, repo, ref, dir = "" } = github;
	const perFile = githubReader(github, rawBase, LOCAL_COPY_HINT);
	let archive: Promise<Map<string, TemplateFile> | undefined> | undefined;
	const download = async () => {
		try {
			const { downloadGithubTarball, parseTar, selectTemplateFiles } =
				await import("../init/bootstrap.js");
			const tar = await downloadGithubTarball(owner, repo, ref, env);
			return new Map(
				selectTemplateFiles(parseTar(tar), dir).map((file) => [
					file.path,
					file,
				]),
			);
		} catch {
			return undefined;
		}
	};
	return async (relativePath, limit) => {
		archive ??= download();
		const files = await archive;
		if (!files) return perFile(relativePath, limit);
		const file = files.get(relativePath);
		if (!file) {
			throw new RegistryError(
				`Registry file ${relativePath} not found in ${describeGithub(github)}.`,
				404,
			);
		}
		if (file.kind !== "file") {
			throw new RegistryError(
				`Registry file ${relativePath} is not a regular file.`,
			);
		}
		if (file.bytes.length > limit) throw tooLarge(relativePath, limit);
		return file.bytes.toString("utf8");
	};
};

export type LoadedTemplate = {
	template: FunctionTemplate;
	sources: Map<string, string>;
};

export type Registry = {
	sources: RegistrySource[];
	entries: RegistryIndexEntry[];
	load: (entry: RegistryIndexEntry) => Promise<LoadedTemplate>;
};

export const templateSourcePaths = (template: FunctionTemplate): string[] =>
	template.operations?.map((operation) => operation.source) ?? [
		"functions/index.ts",
	];

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
		registry: wrap<RegistryIndexDocument>(
			allowGithubTemplateSources(registrySchema),
		),
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
	neonRegistry?: string | false;
	env?: NodeJS.ProcessEnv;
	githubRaw?: string;
};

export const openRegistry = async (
	source?: RegistrySource,
	{
		primary = DEFAULT_REGISTRY_URL,
		fallback = GITHUB_REGISTRY_URL,
		neonRegistry = NEON_REGISTRY_URL,
		env = process.env,
		githubRaw,
	}: RegistryDefaults = {},
): Promise<Registry> => {
	let base: URL | undefined;
	const github: GithubContext = {
		env,
		rawBase: () => {
			base ??= resolveGithubRawBase(env, githubRaw);
			return base;
		},
	};
	if (source) return openRegistryAt(source, source, github);
	const resolved = resolveRegistrySource(env, process.cwd(), primary);
	if (
		resolved.kind !== "url" ||
		resolved.url.href !== new URL(primary).href
	) {
		return openRegistryAt(resolved, resolved, github);
	}
	const mirror: RegistrySource = { kind: "url", url: new URL(fallback) };
	const openExamples = async () => {
		try {
			return await openRegistryAt(resolved, mirror, github);
		} catch (error) {
			if (!(error instanceof RegistryError)) throw error;
			return openRegistryAt(mirror, mirror, github);
		}
	};
	if (neonRegistry === false) return openExamples();
	const repo: RegistrySource = { kind: "url", url: new URL(neonRegistry) };
	const results = await Promise.allSettled([
		openRegistryAt(repo, repo, github),
		openExamples(),
	]);
	for (const result of results) {
		if (
			result.status === "rejected" &&
			!(result.reason instanceof RegistryError)
		) {
			throw result.reason;
		}
	}
	const [neon, examples] = results;
	if (neon.status === "rejected" && examples.status === "rejected") {
		throw neon.reason.status === 404 ? examples.reason : neon.reason;
	}
	return mergeRegistries(
		results.flatMap((result) =>
			result.status === "fulfilled" ? [result.value] : [],
		),
	);
};

const mergeRegistries = (registries: Registry[]): Registry => {
	const owners = new Map<string, Registry>();
	const entries: RegistryIndexEntry[] = [];
	for (const registry of registries) {
		for (const entry of registry.entries) {
			if (owners.has(entry.id)) continue;
			owners.set(entry.id, registry);
			entries.push(entry);
		}
	}
	const sources = registries.flatMap((registry) => registry.sources);
	return {
		sources,
		entries,
		load: async (entry) => {
			const owner = owners.get(entry.id);
			if (!owner) {
				throw new RegistryError(
					`Template "${entry.id}" is not in ${describeRegistrySources(sources)}.`,
				);
			}
			return owner.load(entry);
		},
	};
};

const readerFor = (source: RegistrySource): ReadText =>
	source.kind === "dir" ? dirReader(source.dir) : urlReader(source.url);

const filesReaderFor = (
	files: RegistrySource,
	github: GithubContext,
): ReadText => {
	const repo =
		files.kind === "url"
			? NEON_REPOS.find(
					(candidate) => rawIndexUrl(candidate) === files.url.href,
				)
			: undefined;
	return repo ? archiveReader(repo, github) : readerFor(files);
};

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
	files: RegistrySource,
	github: GithubContext,
): Promise<Registry> => {
	const read = readerFor(source);
	const readFiles = filesReaderFor(files, github);
	const readFile =
		files === source
			? readFiles
			: withStaleIndexHint(readFiles, source, files);
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
		if (entry.unsupportedSource) {
			throw new RegistryError(
				`Template "${entry.id}" needs a newer version of the neon CLI. Update the CLI and retry.`,
			);
		}
		if (!entry.path || !isContainedRelativePath(entry.path)) {
			throw new RegistryError(
				`Template "${entry.id}" has no valid path.`,
			);
		}
		const readEntry = entry.source
			? githubReader(entry.source.github, github.rawBase)
			: readFile;
		const template = parse(
			entry.path,
			await readEntry(entry.path, MAX_JSON_BYTES),
			(text) => parseTemplateItem(text, schemas.template, entry.id),
		);
		const paths = templateSourcePaths(template);
		const unsafe = paths.find((path) => !isContainedRelativePath(path));
		if (unsafe !== undefined) {
			throw new RegistryError(
				`Template "${entry.id}" references an unsafe path: ${unsafe}`,
			);
		}
		const dir = posix.dirname(entry.path);
		const sources = await readSources(
			entry.id,
			[...new Set(paths)],
			(path) =>
				readEntry(
					dir === "." ? path : posix.join(dir, path),
					MAX_FILE_BYTES,
				),
		);
		return { template, sources: new Map(sources) };
	};

	return { sources: [source], entries, load };
};

const MAX_PARALLEL_READS = 6;

const readSources = async (
	templateId: string,
	paths: string[],
	read: (path: string) => Promise<string>,
): Promise<Array<[string, string]>> => {
	const results: Array<[string, string]> = new Array(paths.length);
	let next = 0;
	let total = 0;
	let stopped = false;
	const worker = async () => {
		while (!stopped && next < paths.length) {
			const index = next++;
			const path = paths[index];
			try {
				const text = await read(path);
				total += Buffer.byteLength(text, "utf8");
				if (total > MAX_TOTAL_BYTES) {
					throw new RegistryError(
						`Template "${templateId}" source files exceed the ${MAX_TOTAL_BYTES}-byte total limit.`,
					);
				}
				results[index] = [path, text];
			} catch (error) {
				stopped = true;
				throw error;
			}
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(MAX_PARALLEL_READS, paths.length) },
			worker,
		),
	);
	return results;
};
