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
import { gunzipSync } from "fflate";
import YAML from "yaml";

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

export interface BootstrapTemplate {
	/** Stable id used by `--template` and analytics. */
	id: string;
	/** Human label shown in the interactive selector. */
	title: string;
	/** One-line description shown under the title in the selector. */
	description: string;
	/**
	 * Neon services the template uses (e.g. "Postgres", "Functions"). Shown as a
	 * badge next to the title in the picker. Optional — older manifests omit it.
	 */
	services?: string[];
	/** Neon features this template needs (defaults to ["database"]). */
	requires: NeonFeature[];
	source: {
		owner: string;
		repo: string;
		/** Branch (or tag) the template is pulled from. */
		ref: string;
		/** Subdirectory within the repo to copy (no leading/trailing slash). */
		subdir: string;
	};
}

/**
 * Hardcoded fallback used when every remote manifest source is unreachable.
 * Kept in sync with `neondatabase/examples/bootstrap.yaml` (the source of
 * truth) so that, even fully offline from the manifest, the picker still offers
 * the full set of starters rather than a single template.
 */
export const FALLBACK_TEMPLATES: BootstrapTemplate[] = [
	{
		id: "hono",
		title: "Hono API (Drizzle, Neon Postgres) on Neon Functions",
		description:
			"A Hono API using Drizzle ORM and Neon Postgres, ready to deploy as a Neon Function.",
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
		title: "AI SDK agent (AI Gateway, object storage, Drizzle) on Neon Functions",
		description:
			"A Vercel AI SDK agent on Neon Functions: streams chat through the Neon AI Gateway, generates an image with OpenAI image generation, and stores it in Neon object storage indexed in Postgres via Drizzle.",
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
		title: "Mastra personal agent (AI Gateway, Mastra Memory) on Neon Functions",
		description:
			"A Mastra personal-assistant agent on Neon Functions: streams chat through the Neon AI Gateway and uses Mastra Memory — backed by Neon Postgres — to remember the user across conversation threads via resource-scoped working memory.",
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

const githubToken = (): string =>
	process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";

// A token is never required for public templates, but we forward it when
// present so the same code path works behind proxies that authenticate, and
// (in future) for private template repos.
const downloadHeaders = (): Record<string, string> => ({
	"User-Agent": "neon-init",
	...(githubToken() ? { Authorization: `Bearer ${githubToken()}` } : {}),
});

// The codeload host is overridable so the e2e tests can point the downloader at
// a local server (the same trick `--api-host` uses to redirect the Neon API).
const codeloadBase = (): string =>
	process.env.NEON_BOOTSTRAP_GITHUB_CODELOAD ?? "https://codeload.github.com";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/**
 * Normalize a manifest entry's `services` into a clean string list. Tolerant by
 * design: a missing or non-array value yields `undefined`, and non-string items
 * are dropped, so a malformed `services` never sinks an otherwise-valid
 * template (it just renders without its badge).
 */
const parseServices = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	const services = value.filter(
		(item): item is string =>
			typeof item === "string" && item.trim() !== "",
	);
	return services.length > 0 ? services : undefined;
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
		const services = parseServices(item.services);
		templates.push({
			id: item.id,
			title: item.title,
			description: item.description,
			...(services ? { services } : {}),
			requires,
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
				headers: downloadHeaders(),
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

/**
 * Decode a (decompressed) tar archive into its file/symlink entries. Pure and
 * dependency-free so it can be unit tested without touching the network.
 * Handles the ustar `prefix` field, pax extended headers (type 'x'/'g'), and
 * GNU long-name/long-link headers (type 'L'/'K') so deep template paths and
 * long symlink targets round-trip correctly.
 */
export const parseTar = (buf: Buffer): TarEntry[] => {
	const entries: TarEntry[] = [];
	// Overrides carried from a preceding pax/GNU header to the next real entry.
	let overridePath: string | undefined;
	let overrideLink: string | undefined;
	let offset = 0;

	while (offset + TAR_BLOCK <= buf.length) {
		if (isZeroBlock(buf, offset)) break;

		let name = readTarString(buf, offset, 100);
		const mode = readTarOctal(buf, offset + 100, 8);
		const size = readTarOctal(buf, offset + 124, 12);
		const typeByte = buf[offset + 156];
		const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
		let linkname = readTarString(buf, offset + 157, 100);
		const magic = readTarString(buf, offset + 257, 6);
		if (magic.startsWith("ustar")) {
			const prefix = readTarString(buf, offset + 345, 155);
			if (prefix !== "") name = `${prefix}/${name}`;
		}

		offset += TAR_BLOCK;
		const data = buf.subarray(offset, offset + size);
		offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

		if (type === "x") {
			const records = parsePaxRecords(data);
			if (records.path !== undefined) overridePath = records.path;
			if (records.linkpath !== undefined) overrideLink = records.linkpath;
			continue;
		}
		if (type === "g") {
			// Global pax header (e.g. GitHub's comment block): not per-entry state.
			continue;
		}
		if (type === "L" || type === "K") {
			const longValue = data.toString("utf8").replace(/\0+$/, "");
			if (type === "L") overridePath = longValue;
			else overrideLink = longValue;
			continue;
		}

		if (overridePath !== undefined) name = overridePath;
		if (overrideLink !== undefined) linkname = overrideLink;
		overridePath = undefined;
		overrideLink = undefined;

		entries.push({ name, type, mode, linkname, data: Buffer.from(data) });
	}

	return entries;
};

/**
 * Map decoded tar entries to the files under `subdir`, with the top-level
 * archive directory and the `subdir/` prefix stripped from each path. Pure so
 * it can be unit tested. Directory and other non-regular entries are dropped —
 * writing files re-creates their parent directories.
 */
export const selectTemplateFiles = (
	entries: TarEntry[],
	subdir: string,
): TemplateFile[] => {
	const prefix = `${subdir.replace(/^\/+|\/+$/g, "")}/`;
	const files: TemplateFile[] = [];
	for (const entry of entries) {
		// codeload wraps everything in a single top-level dir ("<repo>-<ref>/");
		// strip that first segment to get the repo-relative path.
		const slash = entry.name.indexOf("/");
		if (slash === -1) continue;
		const repoPath = entry.name.slice(slash + 1);
		if (!repoPath.startsWith(prefix)) continue;
		const path = repoPath.slice(prefix.length);
		if (path === "") continue;
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

const tarballUrl = (template: BootstrapTemplate): string => {
	const { owner, repo, ref } = template.source;
	return `${codeloadBase()}/${owner}/${repo}/tar.gz/${ref}`;
};

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

/**
 * Download a template and resolve it to the exact set of files to write. The
 * entire subtree is captured in one tarball request, so the copy is atomically
 * consistent: a push to the template repo mid-download cannot produce a
 * mismatched checkout (unlike fetching a file list and then each blob).
 */
export const downloadTemplate = async (
	template: BootstrapTemplate,
): Promise<TemplateFile[]> => {
	const url = tarballUrl(template);

	let gzipped: Buffer;
	try {
		const res = await fetch(url, {
			headers: downloadHeaders(),
			signal: AbortSignal.timeout(30_000),
		});
		if (!res.ok) throw friendlyGithubError(res.status, url);
		gzipped = Buffer.from(await res.arrayBuffer());
	} catch (err) {
		throw err instanceof Error ? err : new Error(String(err));
	}

	let tar: Buffer;
	try {
		tar = Buffer.from(gunzipSync(new Uint8Array(gzipped)));
	} catch (err) {
		throw new Error(
			`Failed to decompress the template archive from ${url}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}

	const { owner, repo, ref, subdir } = template.source;
	const files = selectTemplateFiles(parseTar(tar), subdir);
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

/**
 * A bad caller-supplied input that an agent (or human) can correct: an unknown
 * template id or a non-empty target directory. Carries an `agentCode` so an
 * agent surface can report a precise error code instead of a generic
 * INTERNAL_ERROR, while a human path just surfaces the clear `message`.
 */
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

export interface ScaffoldOptions {
	/** Called for non-fatal warnings (e.g. a symlink that fell back to a file). */
	onWarn?: (message: string) => void;
}

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
	const files = await downloadTemplate(template);

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
