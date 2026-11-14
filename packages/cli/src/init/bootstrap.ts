import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Gunzip, gunzipSync } from "fflate";
import YAML from "yaml";
import {
	parseTemplateAgentTooling,
	type TemplateAgentTooling,
} from "../templates/agent_tooling.js";
import { githubRequestHeaders } from "../utils/github_headers.js";

/**
 * A scaffold template that lives in a subdirectory of a public GitHub repo we
 * control. Bootstrapping copies that subdirectory into a target folder —
 * conceptually the same as `degit user/repo/subdir`, but implemented in-house.
 *
 * The whole template is pulled in a single request: we download the repo's
 * gzipped tarball from `codeload.github.com` and extract only the subdir we
 * want. That endpoint is unauthenticated and is NOT subject to the 60-requests
 * per-hour limit of the REST API (`api.github.com`), so bootstrapping works out
 * of the box on shared/corporate networks without a GITHUB_TOKEN. We lean on
 * `fflate` for gunzip and parse the tar in-house, so we never pull in a heavy
 * dependency tree just to copy a few files.
 */

/**
 * Neon features that a template or project may require.
 * Each feature maps to a setup phase that the orchestrator can run.
 */
export type NeonFeature =
	| "database"
	| "auth"
	| "functions"
	| "ai-gateway"
	| "object-storage";

/** Default features when a template doesn't specify `requires`. */
const DEFAULT_REQUIRES: NeonFeature[] = ["database"];

export type BootstrapTemplate = {
	/** Stable id used by `--template` and analytics. */
	id: string;
	/** Human label shown in the interactive selector. */
	title: string;
	/** One-line description shown under the title in the selector. */
	description: string;
	/**
	 * Libraries/frameworks that shape the project (e.g. "Hono", "Drizzle").
	 * Rendered next to the title in the picker so the row reads
	 * "Title (tools)". Optional — older manifests omit it.
	 */
	tools?: string[];
	/**
	 * Neon services the template uses (e.g. "Postgres", "Functions"). Surfaced
	 * alongside the description in the focused row's hint. Optional — older
	 * manifests omit it.
	 */
	services?: string[];
	/** Neon features this template needs (defaults to ["database"]). */
	requires: NeonFeature[];
	/** Skills, MCP servers, and CLIs the template suggests for coding agents. */
	agent?: TemplateAgentTooling;
	source: {
		owner: string;
		repo: string;
		/** Branch (or tag) the template is pulled from. */
		ref: string;
		/** Subdirectory within the repo to copy (no leading/trailing slash). */
		subdir: string;
	};
};

/**
 * Hardcoded fallback used when every remote manifest source is unreachable.
 * Kept in sync with `neondatabase/examples/bootstrap.yaml` (the source of
 * truth) so that, even fully offline from the manifest, the picker still offers
 * the full set of starters rather than a single template.
 */
export const FALLBACK_TEMPLATES: BootstrapTemplate[] = [
	{
		id: "hono",
		title: "REST API",
		description:
			"A Hono REST API on Neon Functions, backed by Lakebase Postgres via Drizzle.",
		tools: ["Hono", "Drizzle"],
		services: ["Postgres", "Functions"],
		requires: ["database", "functions"],
		source: {
			owner: "neondatabase",
			repo: "examples",
			ref: "main",
			subdir: "with-hono",
		},
	},
	{
		id: "ai-sdk",
		title: "Image-generation agent",
		description:
			"A Vercel AI SDK agent that streams chat through the Neon AI Gateway and stores generated images in Neon object storage, indexed in Postgres via Drizzle.",
		tools: ["AI SDK", "Drizzle"],
		services: ["Postgres", "Functions", "Object Storage", "AI Gateway"],
		requires: ["database", "functions", "object-storage", "ai-gateway"],
		source: {
			owner: "neondatabase",
			repo: "examples",
			ref: "main",
			subdir: "with-ai-sdk",
		},
	},
	{
		id: "mastra",
		title: "Personal-assistant agent",
		description:
			"A Mastra agent that streams chat through the Neon AI Gateway and uses Mastra Memory on Lakebase Postgres to remember you across threads.",
		tools: ["Mastra", "Mastra Memory"],
		services: ["Postgres", "Functions", "AI Gateway"],
		requires: ["database", "functions", "ai-gateway"],
		source: {
			owner: "neondatabase",
			repo: "examples",
			ref: "main",
			subdir: "with-mastra",
		},
	},
];

export const templateIds = (templates: BootstrapTemplate[]): string =>
	templates.map((t) => t.id).join(", ");

export const findTemplate = (
	templates: BootstrapTemplate[],
	id: string,
): BootstrapTemplate | undefined => templates.find((t) => t.id === id);

/** A single file or symlink to materialize, already resolved with its bytes. */
export type TemplateFile =
	| {
			kind: "file";
			/** Path relative to the target directory (subdir prefix stripped). */
			path: string;
			bytes: Buffer;
			executable: boolean;
	  }
	| {
			kind: "symlink";
			path: string;
			/** The (relative) link target. */
			target: string;
	  };

// The codeload host is overridable so the e2e tests can point the downloader at
// a local server (the same trick `--api-host` uses to redirect the Neon API).
const codeloadBase = (env: NodeJS.ProcessEnv = process.env): string =>
	env.NEON_BOOTSTRAP_GITHUB_CODELOAD ?? "https://codeload.github.com";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/**
 * Normalize a manifest entry's string list (`tools` or `services`) into a clean
 * array. Tolerant by design: a missing or non-array value yields `undefined`,
 * and non-string/blank items are dropped, so a malformed list never sinks an
 * otherwise-valid template (it just renders without that detail).
 */
const parseStringList = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter(
		(item): item is string =>
			typeof item === "string" && item.trim() !== "",
	);
	return items.length > 0 ? items : undefined;
};

/**
 * A malformed `agent` block drops only the block, like a malformed `tools` list: the
 * template still scaffolds, it just suggests no agent tooling.
 */
const parseAgentBlock = (value: unknown): TemplateAgentTooling | undefined => {
	if (value === undefined) return undefined;
	try {
		return parseTemplateAgentTooling(value);
	} catch {
		return undefined;
	}
};

// ---------------------------------------------------------------------------
// Remote template manifest
// ---------------------------------------------------------------------------

// Primary manifest host is neon.com (CDN-backed, no GitHub rate limiting), with
// the raw GitHub copy as a fallback and the hardcoded list as the last resort.
// A single env override (used by tests) short-circuits the chain.
const NEON_MANIFEST_URL = "https://neon.com/bootstrap/templates.yaml";
const GITHUB_RAW_MANIFEST_URL =
	"https://raw.githubusercontent.com/neondatabase/examples/main/bootstrap.yaml";

function manifestUrls(): string[] {
	const override = process.env.NEON_BOOTSTRAP_MANIFEST_URL;
	if (override) return [override];
	return [NEON_MANIFEST_URL, GITHUB_RAW_MANIFEST_URL];
}

export function parseManifest(text: string): BootstrapTemplate[] {
	const data: unknown = YAML.parse(text);
	if (!isRecord(data) || !Array.isArray(data.templates)) {
		throw new Error(
			'Invalid bootstrap manifest: missing "templates" array.',
		);
	}
	const templates: BootstrapTemplate[] = [];
	for (const item of data.templates) {
		if (
			!isRecord(item) ||
			typeof item.id !== "string" ||
			typeof item.title !== "string" ||
			typeof item.description !== "string" ||
			!isRecord(item.source) ||
			typeof item.source.owner !== "string" ||
			typeof item.source.repo !== "string" ||
			typeof item.source.ref !== "string" ||
			typeof item.source.subdir !== "string"
		) {
			continue;
		}
		// Parse requires — accept a string array, default to ["database"].
		const requires: NeonFeature[] =
			Array.isArray(item.requires) &&
			item.requires.every((r: unknown) => typeof r === "string")
				? (item.requires as NeonFeature[])
				: DEFAULT_REQUIRES;
		const tools = parseStringList(item.tools);
		const services = parseStringList(item.services);
		const agent = parseAgentBlock(item.agent);
		templates.push({
			id: item.id,
			title: item.title,
			description: item.description,
			...(tools ? { tools } : {}),
			...(services ? { services } : {}),
			requires,
			...(agent ? { agent } : {}),
			source: {
				owner: item.source.owner,
				repo: item.source.repo,
				ref: item.source.ref,
				subdir: item.source.subdir,
			},
		});
	}
	return templates;
}

/**
 * Fetch the template manifest, trying each source in {@link manifestUrls} in
 * order and returning the first that yields a non-empty template list. Falls
 * back to the hardcoded list when every source is unreachable or empty, so the
 * picker never fails just because a host is down.
 */
export async function fetchTemplates(): Promise<BootstrapTemplate[]> {
	for (const url of manifestUrls()) {
		try {
			const res = await fetch(url, {
				headers: githubRequestHeaders(url),
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const templates = parseManifest(await res.text());
			if (templates.length > 0) return templates;
		} catch {
			// Try the next source.
		}
	}
	return FALLBACK_TEMPLATES;
}

// ---------------------------------------------------------------------------
// Tar parsing
// ---------------------------------------------------------------------------

/** A raw entry decoded from a tar stream, before subdir filtering. */
type TarEntry = {
	/** Full path as stored in the archive (includes the top-level dir). */
	name: string;
	/** POSIX type flag: '0' file, '5' directory, '2' symlink, etc. */
	type: string;
	/** File permission bits. */
	mode: number;
	/** Symlink target (for type '2'). */
	linkname: string;
	/** File contents (for type '0'). */
	data: Buffer;
};

const TAR_BLOCK = 512;

const readTarString = (buf: Buffer, offset: number, length: number): string => {
	let end = offset;
	const max = offset + length;
	while (end < max && buf[end] !== 0) end++;
	return buf.toString("utf8", offset, end);
};

const readTarOctal = (buf: Buffer, offset: number, length: number): number => {
	const text = readTarString(buf, offset, length).trim();
	if (text === "") return 0;
	const value = parseInt(text, 8);
	return Number.isNaN(value) ? 0 : value;
};

const isZeroBlock = (buf: Buffer, offset: number): boolean => {
	for (let i = offset; i < offset + TAR_BLOCK; i++) {
		if (buf[i] !== 0) return false;
	}
	return true;
};

const paddedSize = (size: number): number =>
	Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

/**
 * Parse pax extended-header records ("<len> <key>=<value>\n"). GitHub uses
 * these for the global header and for any path that doesn't fit the legacy
 * 100-byte name field, so we must honor at least `path` and `linkpath`.
 */
const parsePaxRecords = (data: Buffer): Record<string, string> => {
	const records: Record<string, string> = {};
	let pos = 0;
	const text = data.toString("utf8");
	while (pos < text.length) {
		const space = text.indexOf(" ", pos);
		if (space === -1) break;
		const len = parseInt(text.slice(pos, space), 10);
		if (Number.isNaN(len) || len <= 0) break;
		const record = text.slice(space + 1, pos + len - 1); // drop trailing "\n"
		const eq = record.indexOf("=");
		if (eq !== -1) records[record.slice(0, eq)] = record.slice(eq + 1);
		pos += len;
	}
	return records;
};

type TarHeader = Omit<TarEntry, "data"> & { size: number };

const decodeTarHeader = (block: Buffer): TarHeader => {
	let name = readTarString(block, 0, 100);
	const typeByte = block[156];
	const magic = readTarString(block, 257, 6);
	if (magic.startsWith("ustar")) {
		const prefix = readTarString(block, 345, 155);
		if (prefix !== "") name = `${prefix}/${name}`;
	}
	return {
		name,
		type: typeByte === 0 ? "0" : String.fromCharCode(typeByte),
		mode: readTarOctal(block, 100, 8),
		size: readTarOctal(block, 124, 12),
		linkname: readTarString(block, 157, 100),
	};
};

/**
 * Incremental tar decoder: bytes go in as they arrive, entries come out in
 * archive order. `keep` decides per entry whether its contents are copied, so
 * a caller after one subdirectory never holds the rest of the archive in
 * memory; an unkept entry is reported with empty `data` as soon as its header
 * is read. Returning false from `onEntry` stops decoding.
 *
 * Handles the ustar `prefix` field, pax extended headers (type 'x'/'g'), and
 * GNU long-name/long-link headers (type 'L'/'K') so deep template paths and
 * long symlink targets round-trip correctly.
 */
export class TarDecoder {
	private chunks: Buffer[] = [];
	private buffered = 0;
	private skip = 0;
	/** The header whose contents are still arriving. */
	private pending: (TarHeader & { keep: boolean }) | undefined;
	// Overrides carried from a preceding pax/GNU header to the next real entry.
	private overridePath: string | undefined;
	private overrideLink: string | undefined;
	/** True once the end-of-archive block is read or `onEntry` stopped decoding. */
	done = false;

	constructor(
		private readonly onEntry: (entry: TarEntry) => boolean | undefined,
		private readonly keep: (name: string) => boolean = () => true,
	) {}

	push(chunk: Uint8Array): void {
		if (this.done || chunk.byteLength === 0) return;
		this.chunks.push(
			Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
		);
		this.buffered += chunk.byteLength;
		this.drain();
	}

	/**
	 * Report an entry whose contents were cut off by the end of input with what
	 * did arrive, as a whole-buffer parse would.
	 */
	end(): void {
		const header = this.pending;
		if (this.done || header === undefined) return;
		this.pending = undefined;
		this.consume(header, this.take(Math.min(this.buffered, header.size)));
		this.done = true;
	}

	private drain(): void {
		while (!this.done) {
			if (this.skip > 0) {
				this.discard(Math.min(this.skip, this.buffered));
				if (this.skip > 0) return;
			}
			const header = this.pending;
			if (header !== undefined) {
				if (this.buffered < header.size) return;
				this.pending = undefined;
				const data = this.take(header.size);
				this.skip = paddedSize(header.size) - header.size;
				this.consume(header, data);
				continue;
			}
			if (this.buffered < TAR_BLOCK) return;
			const block = this.take(TAR_BLOCK);
			if (isZeroBlock(block, 0)) {
				this.done = true;
				return;
			}
			this.start(decodeTarHeader(block));
		}
	}

	private start(header: TarHeader): void {
		if (header.type === "g") {
			// Global pax header (e.g. GitHub's comment block): not per-entry state.
			this.skip = paddedSize(header.size);
			return;
		}
		if (header.type === "x" || header.type === "L" || header.type === "K") {
			this.pending = { ...header, keep: true };
			return;
		}
		if (this.overridePath !== undefined) header.name = this.overridePath;
		if (this.overrideLink !== undefined)
			header.linkname = this.overrideLink;
		this.overridePath = undefined;
		this.overrideLink = undefined;
		if (header.size > 0 && this.keep(header.name)) {
			this.pending = { ...header, keep: true };
			return;
		}
		this.skip = paddedSize(header.size);
		this.consume({ ...header, keep: false }, Buffer.alloc(0));
	}

	private consume(header: TarHeader & { keep: boolean }, data: Buffer): void {
		if (header.type === "x") {
			const records = parsePaxRecords(data);
			if (records.path !== undefined) this.overridePath = records.path;
			if (records.linkpath !== undefined)
				this.overrideLink = records.linkpath;
			return;
		}
		if (header.type === "L" || header.type === "K") {
			const longValue = data.toString("utf8").replace(/\0+$/, "");
			if (header.type === "L") this.overridePath = longValue;
			else this.overrideLink = longValue;
			return;
		}
		const { name, type, mode, linkname } = header;
		if (this.onEntry({ name, type, mode, linkname, data }) === false) {
			this.done = true;
		}
	}

	/** Remove `n` buffered bytes as one Buffer that owns its memory. */
	private take(n: number): Buffer {
		const out = Buffer.allocUnsafe(n);
		let filled = 0;
		while (filled < n) {
			const chunk = this.chunks[0] as Buffer;
			const count = Math.min(chunk.length, n - filled);
			chunk.copy(out, filled, 0, count);
			filled += count;
			this.dropFront(chunk, count);
		}
		this.buffered -= n;
		return out;
	}

	private discard(n: number): void {
		let left = n;
		while (left > 0) {
			const chunk = this.chunks[0] as Buffer;
			const count = Math.min(chunk.length, left);
			left -= count;
			this.dropFront(chunk, count);
		}
		this.buffered -= n;
		this.skip -= n;
	}

	private dropFront(chunk: Buffer, count: number): void {
		if (count === chunk.length) this.chunks.shift();
		else this.chunks[0] = chunk.subarray(count);
	}
}

/**
 * Decode a (decompressed) tar archive into its file/symlink entries. Pure and
 * dependency-free so it can be unit tested without touching the network.
 */
export const parseTar = (buf: Buffer): TarEntry[] => {
	const entries: TarEntry[] = [];
	const decoder = new TarDecoder((entry) => {
		entries.push(entry);
		return true;
	});
	decoder.push(buf);
	decoder.end();
	return entries;
};

/**
 * Map decoded tar entries to the files under `subdir`, with the top-level
 * archive directory and the `subdir/` prefix stripped from each path. Pure so
 * it can be unit tested. Directory and other non-regular entries are dropped —
 * writing files re-creates their parent directories.
 */
const subdirPrefix = (subdir: string): string => {
	const trimmed = subdir.replace(/^\/+|\/+$/g, "");
	return trimmed ? `${trimmed}/` : "";
};

/** The path of archive entry `name` relative to `prefix`, or undefined outside it. */
const pathUnderPrefix = (name: string, prefix: string): string | undefined => {
	// codeload wraps everything in a single top-level dir ("<repo>-<ref>/");
	// strip that first segment to get the repo-relative path.
	const slash = name.indexOf("/");
	if (slash === -1) return undefined;
	const repoPath = name.slice(slash + 1);
	return repoPath.startsWith(prefix)
		? repoPath.slice(prefix.length)
		: undefined;
};

export const selectTemplateFiles = (
	entries: TarEntry[],
	subdir: string,
): TemplateFile[] => {
	const prefix = subdirPrefix(subdir);
	const files: TemplateFile[] = [];
	for (const entry of entries) {
		const path = pathUnderPrefix(entry.name, prefix);
		if (path === undefined || path === "") continue;
		if (entry.type === "2") {
			files.push({ kind: "symlink", path, target: entry.linkname });
		} else if (entry.type === "0" || entry.type === "7") {
			files.push({
				kind: "file",
				path,
				bytes: entry.data,
				executable: (entry.mode & 0o111) !== 0,
			});
		}
		// Directories ('5') and any other node types are intentionally skipped.
	}
	return files;
};

export const githubTarballUrl = (
	owner: string,
	repo: string,
	ref: string,
	env: NodeJS.ProcessEnv = process.env,
): string => `${codeloadBase(env)}/${owner}/${repo}/tar.gz/${ref}`;

const friendlyGithubError = (status: number, url: string): Error => {
	if (status === 404) {
		return new Error(
			`GitHub returned 404 for ${url}. The template repo or ref may have moved.`,
		);
	}
	if (status === 403 || status === 429) {
		return new Error(
			`GitHub rate limited the template download (${url}). Set a GITHUB_TOKEN environment variable to raise the limit, then retry.`,
		);
	}
	return new Error(`GitHub returned HTTP ${status} for ${url}.`);
};

const decompressError = (url: string, err: unknown): Error =>
	new Error(
		`Failed to decompress the template archive from ${url}: ${
			err instanceof Error ? err.message : String(err)
		}`,
	);

export const downloadGithubTarball = async (
	owner: string,
	repo: string,
	ref: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer> => {
	const url = githubTarballUrl(owner, repo, ref, env);

	let gzipped: Buffer;
	try {
		const res = await fetch(url, {
			headers: githubRequestHeaders(url, env),
			signal: AbortSignal.timeout(30_000),
		});
		if (!res.ok) throw friendlyGithubError(res.status, url);
		gzipped = Buffer.from(await res.arrayBuffer());
	} catch (err) {
		throw err instanceof Error ? err : new Error(String(err));
	}

	try {
		return Buffer.from(gunzipSync(new Uint8Array(gzipped)));
	} catch (err) {
		throw decompressError(url, err);
	}
};

/**
 * Stream the tarball at `url` through gunzip into `decoder`, and stop reading
 * as soon as the decoder is done, so bytes it no longer wants are never
 * downloaded.
 */
const streamGithubTarball = async (
	url: string,
	decoder: TarDecoder,
	signal: AbortSignal | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
	const timeout = AbortSignal.timeout(30_000);
	let res: Response;
	try {
		res = await fetch(url, {
			headers: githubRequestHeaders(url, env),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
	} catch (err) {
		throw err instanceof Error ? err : new Error(String(err));
	}
	if (!res.ok) throw friendlyGithubError(res.status, url);

	const gunzip = new Gunzip((chunk) => decoder.push(chunk));
	const push = (chunk: Uint8Array, final: boolean): void => {
		try {
			gunzip.push(chunk, final);
		} catch (err) {
			throw decompressError(url, err);
		}
	};
	const reader = res.body?.getReader();
	if (reader === undefined) {
		push(new Uint8Array(0), true);
		decoder.end();
		return;
	}
	let finished = false;
	try {
		while (!decoder.done) {
			const { done, value } = await reader.read();
			if (done) {
				finished = true;
				push(new Uint8Array(0), true);
				decoder.end();
				return;
			}
			push(value, false);
		}
	} catch (err) {
		throw err instanceof Error ? err : new Error(String(err));
	} finally {
		if (!finished) reader.cancel().catch(() => {});
	}
};

/**
 * Download a template and resolve it to the exact set of files to write. The
 * entire subtree is captured in one tarball request, so the copy is atomically
 * consistent: a push to the template repo mid-download cannot produce a
 * mismatched checkout (unlike fetching a file list and then each blob).
 *
 * codeload builds the tarball with `git archive`, which writes a directory's
 * whole subtree as one contiguous run of entries. So the first entry outside
 * the subdir after entries inside it means the subdir is complete, and the
 * rest of the repository is not downloaded.
 */
export const downloadTemplate = async (
	template: BootstrapTemplate,
	options: { signal?: AbortSignal } = {},
): Promise<TemplateFile[]> => {
	const { owner, repo, ref, subdir } = template.source;
	const url = githubTarballUrl(owner, repo, ref);
	const prefix = subdirPrefix(subdir);
	const inSubdir = (name: string): boolean =>
		pathUnderPrefix(name, prefix) !== undefined;
	const entries: TarEntry[] = [];
	const decoder = new TarDecoder((entry) => {
		if (inSubdir(entry.name)) {
			entries.push(entry);
			return true;
		}
		return entries.length === 0;
	}, inSubdir);
	await streamGithubTarball(url, decoder, options.signal);
	const files = selectTemplateFiles(entries, subdir);
	if (files.length === 0) {
		throw new Error(
			`Template subdirectory "${subdir}" was not found in ${owner}/${repo}@${ref}.`,
		);
	}
	return files;
};

// ---------------------------------------------------------------------------
// Target validation + scaffolding to disk
// ---------------------------------------------------------------------------

/** `agentCode` lets programmatic callers branch without parsing human-readable messages. */
export class BootstrapInputError extends Error {
	readonly agentCode: string;
	constructor(message: string, agentCode: string) {
		super(message);
		this.name = "BootstrapInputError";
		this.agentCode = agentCode;
	}
}

/**
 * Ensure `dir` is safe to scaffold into: it must be missing, or an empty
 * directory (a lone `.git` is ignored so you can scaffold into a freshly
 * `git init`ed folder). `force` allows scaffolding into a non-empty directory,
 * overwriting colliding files. Throws a {@link BootstrapInputError} otherwise.
 */
export const ensureTargetUsable = (dir: string, force: boolean): void => {
	if (!existsSync(dir)) return;
	if (!statSync(dir).isDirectory()) {
		throw new BootstrapInputError(
			`Target ${dir} already exists and is not a directory.`,
			"TARGET_NOT_DIRECTORY",
		);
	}
	const contents = readdirSync(dir).filter((name) => name !== ".git");
	if (contents.length > 0 && !force) {
		throw new BootstrapInputError(
			`Target directory ${dir} is not empty. Use --force to scaffold into it anyway (colliding files will be overwritten), or choose an empty directory.`,
			"TARGET_NOT_EMPTY",
		);
	}
};

const isSymlink = (path: string): boolean => {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
};

const errnoCode = (err: unknown): string | undefined => {
	if (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		typeof err.code === "string"
	) {
		return err.code;
	}
	return undefined;
};

const writeSymlink = (
	dest: string,
	target: string,
	onWarn?: (message: string) => void,
): void => {
	if (isSymlink(dest)) rmSync(dest, { force: true });
	try {
		symlinkSync(target, dest);
	} catch (err) {
		// Windows refuses symlinks without elevated rights / developer mode. The
		// template still works for most tooling if we drop a regular file holding
		// the link target, so we degrade gracefully instead of failing the copy.
		if (errnoCode(err) === "EPERM" || process.platform === "win32") {
			onWarn?.(
				`Could not create symlink ${dest} -> ${target}; wrote it as a regular file instead.`,
			);
			writeFileSync(dest, target);
			return;
		}
		throw err;
	}
};

export type ScaffoldOptions = {
	/** Called for non-fatal warnings (e.g. a symlink that fell back to a file). */
	onWarn?: (message: string) => void;
	/** A {@link downloadTemplate} of `template` the caller already started. */
	download?: Promise<TemplateFile[]>;
};

/**
 * Download `template` and materialize its files into `targetDir`, creating
 * parent directories, preserving executable bits, and recreating symlinks
 * (with a graceful regular-file fallback on platforms that disallow them).
 * Returns the number of files written. The caller is responsible for any
 * target validation ({@link ensureTargetUsable}) and user-facing progress.
 */
export const scaffoldTemplate = async (
	template: BootstrapTemplate,
	targetDir: string,
	options: ScaffoldOptions = {},
): Promise<number> => {
	const files = await (options.download ?? downloadTemplate(template));

	mkdirSync(targetDir, { recursive: true });
	for (const file of files) {
		const dest = join(targetDir, file.path);
		mkdirSync(dirname(dest), { recursive: true });
		if (file.kind === "symlink") {
			writeSymlink(dest, file.target, options.onWarn);
		} else {
			writeFileSync(dest, file.bytes);
			if (file.executable) chmodSync(dest, 0o755);
		}
	}
	return files.length;
};
