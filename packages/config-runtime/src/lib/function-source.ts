import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import {
	ErrorCode,
	FUNCTION_ARCHIVE_ENTRIES,
	FUNCTION_SOURCE_ENTRIES,
	type FunctionBundle,
	isFunctionArchiveEntry,
	PlatformError,
	pickFunctionSourceEntry,
	type ResolvedFunctionConfig,
} from "@neon/config";

export type UnbundledVia = "none" | "no-bundle";

/**
 * Resolve `source` to the file esbuild should bundle. A file is used as the entry
 * (any name). A directory is searched in {@link FUNCTION_SOURCE_ENTRIES} order; only
 * real files count, so a directory named `index.ts` cannot beat `index.js`.
 */
export async function resolveEsbuildEntry(source: string): Promise<string> {
	let sourceStat: Awaited<ReturnType<typeof stat>>;
	try {
		sourceStat = await stat(source);
	} catch (cause) {
		throw new PlatformError(
			ErrorCode.InvalidConfig,
			`Function source ${source} does not exist.`,
			{ cause },
		);
	}
	if (sourceStat.isFile()) return source;
	if (!sourceStat.isDirectory()) {
		throw new PlatformError(
			ErrorCode.InvalidConfig,
			`Function source ${source} is neither a file nor a directory.`,
		);
	}

	const present: string[] = [];
	await Promise.all(
		FUNCTION_SOURCE_ENTRIES.map(async (name) => {
			const candidate = join(source, name);
			const candidateStat = await stat(candidate).catch(() => null);
			if (candidateStat?.isFile()) present.push(name);
		}),
	);
	const picked = pickFunctionSourceEntry(present);
	if (picked === undefined) {
		throw new PlatformError(
			ErrorCode.InvalidConfig,
			`No entry file found in ${source}. Expected one of: ${FUNCTION_SOURCE_ENTRIES.join(", ")}.`,
		);
	}
	return join(source, picked);
}

/**
 * Read a prebuilt `source` into a {@link FunctionBundle} without esbuild. The `"none"`
 * bundler / CLI `--no-bundle` path.
 *
 * A directory is shipped with its layout preserved and must have `index.mjs` or
 * `index.js` at its root. A file must be named one of those. TypeScript cannot be
 * shipped unbundled.
 */
export async function bundleAsIs(
	fn: ResolvedFunctionConfig,
	options: { via?: UnbundledVia } = {},
): Promise<FunctionBundle> {
	const via = options.via ?? "none";
	let sourceStat: Awaited<ReturnType<typeof stat>>;
	try {
		sourceStat = await stat(fn.source);
	} catch (cause) {
		throw new PlatformError(
			ErrorCode.InvalidConfig,
			`Function "${fn.slug}" bundler is "none" but its source ${fn.source} does not exist.`,
			{ cause },
		);
	}

	if (sourceStat.isDirectory()) {
		const entries: FunctionBundle = {};
		await collectDirectory(fn.source, fn.source, entries);
		if (FUNCTION_ARCHIVE_ENTRIES.some((name) => name in entries)) {
			return entries;
		}
		if ("index.ts" in entries) {
			throw new PlatformError(
				ErrorCode.InvalidConfig,
				typescriptUnbundledMessage(fn, via),
			);
		}
		throw new PlatformError(
			ErrorCode.InvalidConfig,
			`Function "${fn.slug}" source directory ${fn.source} has no entry module at its root ` +
				`(expected one of: ${FUNCTION_ARCHIVE_ENTRIES.join(", ")}). The Functions runtime imports the archive by that name.`,
		);
	}

	if (!sourceStat.isFile()) {
		throw new PlatformError(
			ErrorCode.InvalidConfig,
			`Function "${fn.slug}" source ${fn.source} is neither a file nor a directory.`,
		);
	}

	const name = basename(fn.source);
	if (name === "index.ts") {
		throw new PlatformError(
			ErrorCode.InvalidConfig,
			typescriptUnbundledMessage(fn, via),
		);
	}
	if (!isFunctionArchiveEntry(name)) {
		throw new PlatformError(
			ErrorCode.InvalidConfig,
			via === "no-bundle"
				? `${fn.source} must be named index.mjs or index.js to ship with --no-bundle (got "${name}"). Omit --no-bundle to esbuild it, or rename the file.`
				: `Function "${fn.slug}" bundler is "none" but ${fn.source} is named "${name}". ` +
						`The Functions runtime imports index.mjs or index.js at the archive root.`,
		);
	}
	return { [name]: new Uint8Array(await readFile(fn.source)) };
}

const typescriptUnbundledMessage = (
	fn: ResolvedFunctionConfig,
	via: UnbundledVia,
): string =>
	via === "no-bundle"
		? `TypeScript must be bundled. ${fn.source} has no index.mjs or index.js; omit --no-bundle to esbuild it, or emit one of those files.`
		: `Function "${fn.slug}" bundler is "none" but ${fn.source} is TypeScript. ` +
			`Use the default esbuild bundler, or emit index.mjs / index.js.`;

/**
 * Recursively read `dir` into `entries`, keying each file by its POSIX path relative to
 * `root`. Empty directories are dropped: an archive carries files, and a bundle's layout is
 * defined by the paths of the files in it.
 */
async function collectDirectory(
	root: string,
	dir: string,
	entries: FunctionBundle,
): Promise<void> {
	const dirents = await readdir(dir, { withFileTypes: true });
	await Promise.all(
		dirents.map(async (dirent) => {
			const abs = join(dir, dirent.name);
			if (dirent.isDirectory()) {
				await collectDirectory(root, abs, entries);
				return;
			}
			// Symlinks are followed as their target: a bundle is a snapshot of bytes, and a
			// symlink into node_modules or up out of the tree would not resolve once unpacked.
			if (dirent.isSymbolicLink()) {
				const target = await stat(abs).catch(() => null);
				if (!target || target.isDirectory()) return;
			}
			const key = relative(root, abs).split(sep).join("/");
			entries[key] = new Uint8Array(await readFile(abs));
		}),
	);
}
