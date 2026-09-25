import { posix } from "node:path";
import { Gunzip } from "fflate";

export type GithubTemplateSource = {
	owner: string;
	repo: string;
	ref: string;
	subdir: string;
};

/** A single file or symlink to materialize, already resolved with its bytes. */
export type TemplateFile =
	| {
			kind: "file";
			/** POSIX path relative to the target directory. */
			path: string;
			bytes: Buffer;
			executable: boolean;
	  }
	| {
			kind: "symlink";
			path: string;
			/** Relative target that resolves inside the template root. */
			target: string;
	  };

/** A raw entry decoded from a tar stream, before subdirectory filtering. */
export type TarEntry = {
	name: string;
	type: string;
	mode: number;
	linkname: string;
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
	const value = Number.parseInt(text, 8);
	return Number.isNaN(value) ? 0 : value;
};

const isZeroBlock = (buf: Buffer, offset: number): boolean => {
	for (let i = offset; i < offset + TAR_BLOCK; i++) {
		if (buf[i] !== 0) return false;
	}
	return true;
};

const parsePaxRecords = (data: Buffer): Record<string, string> => {
	const records: Record<string, string> = {};
	let pos = 0;
	const text = data.toString("utf8");
	while (pos < text.length) {
		const space = text.indexOf(" ", pos);
		if (space === -1) break;
		const len = Number.parseInt(text.slice(pos, space), 10);
		if (Number.isNaN(len) || len <= 0) break;
		const record = text.slice(space + 1, pos + len - 1);
		const eq = record.indexOf("=");
		if (eq !== -1) records[record.slice(0, eq)] = record.slice(eq + 1);
		pos += len;
	}
	return records;
};

/**
 * Decode a tar archive. Handles ustar prefixes, pax path/link overrides, and
 * GNU long path/link records used by GitHub codeload archives.
 */
export const parseTar = (buf: Buffer): TarEntry[] => {
	const entries: TarEntry[] = [];
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
		if (
			!Number.isSafeInteger(size) ||
			size < 0 ||
			offset + size > buf.length
		) {
			throw new Error(`Invalid tar entry size for "${name}".`);
		}
		const data = buf.subarray(offset, offset + size);
		offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

		if (type === "x") {
			const records = parsePaxRecords(data);
			if (records.path !== undefined) overridePath = records.path;
			if (records.linkpath !== undefined) overrideLink = records.linkpath;
			continue;
		}
		if (type === "g") continue;
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

const WINDOWS_ABSOLUTE = /^[A-Za-z]:/;

const pathSegments = (value: string, label: string): string[] => {
	if (
		value === "" ||
		value.includes("\0") ||
		value.includes("\\") ||
		value.startsWith("/") ||
		WINDOWS_ABSOLUTE.test(value)
	) {
		throw new Error(`${label} must be a relative POSIX path: "${value}".`);
	}
	const segments = value.split("/").filter((part) => part !== "");
	if (segments.some((part) => part === "." || part === "..")) {
		throw new Error(`${label} must not contain "." or "..": "${value}".`);
	}
	return segments;
};

const normalizedSubdir = (subdir: string): string => {
	// Keep bootstrap's historical tolerance for a leading/trailing slash while
	// applying strict validation to the actual repo-relative value.
	const normalized = subdir.replace(/^\/+|\/+$/g, "");
	pathSegments(normalized, "Template subdirectory");
	return normalized;
};

const validateSymlinkTarget = (path: string, target: string): void => {
	if (
		target === "" ||
		target.includes("\0") ||
		target.includes("\\") ||
		target.startsWith("/") ||
		WINDOWS_ABSOLUTE.test(target)
	) {
		throw new Error(
			`Symlink target for "${path}" must be a relative POSIX path: "${target}".`,
		);
	}
	const resolved = posix.normalize(posix.join(posix.dirname(path), target));
	if (
		resolved === ".." ||
		resolved.startsWith("../") ||
		posix.isAbsolute(resolved)
	) {
		throw new Error(
			`Symlink "${path}" points outside the template root: "${target}".`,
		);
	}
};

export const validateTemplateFiles = (files: readonly TemplateFile[]): void => {
	const paths = new Set<string>();
	const symlinks = new Set<string>();
	for (const file of files) {
		pathSegments(file.path, "Template file path");
		if (paths.has(file.path)) {
			throw new Error(
				`Template archive contains duplicate path "${file.path}".`,
			);
		}
		paths.add(file.path);
		if (file.kind === "symlink") {
			validateSymlinkTarget(file.path, file.target);
			symlinks.add(file.path);
		}
	}
	for (const path of paths) {
		let parent = posix.dirname(path);
		while (parent !== ".") {
			if (symlinks.has(parent)) {
				throw new Error(
					`Template path "${path}" is nested under symlink "${parent}".`,
				);
			}
			parent = posix.dirname(parent);
		}
	}
};

/**
 * Select regular files and contained symlinks below a repository subdirectory.
 * Unsafe archive names fail the entire extraction instead of being skipped.
 */
export const selectTemplateFiles = (
	entries: TarEntry[],
	subdir: string,
): TemplateFile[] => {
	const prefix = `${normalizedSubdir(subdir)}/`;
	const files: TemplateFile[] = [];
	for (const entry of entries) {
		const segments = pathSegments(entry.name, "Archive entry path");
		if (segments.length < 2) continue;
		const repoPath = segments.slice(1).join("/");
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
	}
	validateTemplateFiles(files);
	return files;
};

const githubToken = (): string =>
	process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";

export const githubDownloadHeaders = (): Record<string, string> => ({
	"User-Agent": "neon",
	...(githubToken() ? { Authorization: `Bearer ${githubToken()}` } : {}),
});

/**
 * Whether `base` is a real GitHub host, so a bearer token is safe to send. The
 * codeload host is overridable (env var, option, a test server, a mirror), and a
 * GitHub credential must never be forwarded to a non-GitHub override — so auth is
 * attached only for `https://` GitHub hosts and dropped for anything else.
 */
const isGithubCodeloadHost = (base: string): boolean => {
	try {
		const { protocol, hostname } = new URL(base);
		if (protocol !== "https:") return false;
		return (
			hostname === "github.com" ||
			hostname === "codeload.github.com" ||
			hostname.endsWith(".github.com")
		);
	} catch {
		return false;
	}
};

// Practical ceilings so a hostile or accidental archive can't exhaust memory.
// codeload returns the *whole* repo tarball, so these are generous — large
// enough for a real multi-example repo, small enough to stop a runaway zip bomb.
// Both the compressed download and the running decompressed total are bounded;
// the tar parser separately rejects any entry that overruns its buffer.
const MAX_COMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 300 * 1024 * 1024;

/**
 * Gunzip `compressed`, aborting as soon as the running decompressed total would
 * exceed {@link MAX_DECOMPRESSED_BYTES}. Streaming (rather than `gunzipSync`) is
 * what makes the cap effective against a bomb whose tiny compressed form expands
 * to gigabytes: the limit is enforced mid-decompression, not after.
 */
const gunzipWithLimit = (compressed: Uint8Array, url: string): Buffer => {
	const chunks: Uint8Array[] = [];
	let total = 0;
	const gunzip = new Gunzip((chunk) => {
		total += chunk.length;
		if (total > MAX_DECOMPRESSED_BYTES) {
			throw new Error(
				`Template archive from ${url} expands past the ${MAX_DECOMPRESSED_BYTES}-byte decompressed limit.`,
			);
		}
		chunks.push(chunk);
	});
	gunzip.push(compressed, true);
	return Buffer.concat(chunks);
};

export type GithubDownloadOptions = {
	codeloadBase?: string;
	timeoutMs?: number;
};

const validateSource = (source: GithubTemplateSource): void => {
	const githubName = /^[A-Za-z0-9_.-]+$/;
	if (!githubName.test(source.owner) || !githubName.test(source.repo)) {
		throw new Error(
			"GitHub template owner and repo contain invalid characters.",
		);
	}
	if (
		source.ref.trim() === "" ||
		source.ref.includes("\0") ||
		source.ref.includes("\\") ||
		source.ref.startsWith("/") ||
		source.ref.includes("?") ||
		source.ref.includes("#") ||
		source.ref
			.split("/")
			.some((part) => part === "" || part === "." || part === "..")
	) {
		throw new Error(`Invalid GitHub template ref "${source.ref}".`);
	}
	normalizedSubdir(source.subdir);
};

/**
 * A template archive could not be downloaded because of a connection-level
 * failure (DNS, refused/reset connection, offline, or a request timeout) — the
 * request never got an HTTP response. This is deliberately its own type so the
 * top-level handler can print a template-specific message instead of the generic
 * "Could not reach the Neon API" hint: a codeload/GitHub outage is not a Neon
 * API outage, and the two point the user at different things to check. The
 * underlying error is preserved as `cause` for `--debug`.
 */
export class TemplateDownloadError extends Error {
	// Stored as an own property rather than passed to `super(message, { cause })`:
	// this package targets a lib without `ErrorOptions`, so the two-argument Error
	// constructor does not type-check (see `RequestTimeoutError` in api.ts).
	readonly cause: unknown;

	constructor(url: string, cause: unknown) {
		super(
			`Could not download the template archive from ${url} (the request failed or timed out). ` +
				"Check your internet connection and that the repository and ref are reachable, then retry.",
		);
		this.name = "TemplateDownloadError";
		this.cause = cause;
	}
}

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

/** Download and safely select one subdirectory from a GitHub tarball. */
export const downloadGithubTemplate = async (
	source: GithubTemplateSource,
	options: GithubDownloadOptions = {},
): Promise<TemplateFile[]> => {
	validateSource(source);
	const base = (
		options.codeloadBase ??
		process.env.NEON_BOOTSTRAP_GITHUB_CODELOAD ??
		"https://codeload.github.com"
	).replace(/\/+$/, "");
	const url = `${base}/${source.owner}/${source.repo}/tar.gz/${source.ref}`;
	// Send credentials only to an actual GitHub host, never to a codeload override.
	const headers = isGithubCodeloadHost(base)
		? githubDownloadHeaders()
		: { "User-Agent": "neon" };
	let response: Response;
	try {
		response = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
		});
	} catch (error) {
		// A thrown `fetch` (vs. a non-ok response) means no response ever arrived:
		// a connection error or the AbortSignal timeout. Re-label it so the CLI
		// does not report a template-host outage as a Neon API outage.
		throw new TemplateDownloadError(url, error);
	}
	if (!response.ok) throw friendlyGithubError(response.status, url);

	// Reject an over-large body up front when the server declares its size; the
	// decompressed cap below is the real defense (a lying/omitted length can't
	// defeat it), this just fails fast on the common honest case.
	const declaredLength = Number(response.headers.get("content-length"));
	if (
		Number.isFinite(declaredLength) &&
		declaredLength > MAX_COMPRESSED_BYTES
	) {
		throw new Error(
			`Template archive from ${url} is larger than the ${MAX_COMPRESSED_BYTES}-byte download limit.`,
		);
	}

	const compressed = new Uint8Array(await response.arrayBuffer());
	if (compressed.byteLength > MAX_COMPRESSED_BYTES) {
		throw new Error(
			`Template archive from ${url} is larger than the ${MAX_COMPRESSED_BYTES}-byte download limit.`,
		);
	}

	let tar: Buffer;
	try {
		tar = gunzipWithLimit(compressed, url);
	} catch (error) {
		throw new Error(
			`Failed to decompress the template archive from ${url}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	const files = selectTemplateFiles(parseTar(tar), source.subdir);
	if (files.length === 0) {
		throw new Error(
			`Template subdirectory "${source.subdir}" was not found in ${source.owner}/${source.repo}@${source.ref}.`,
		);
	}
	return files;
};
