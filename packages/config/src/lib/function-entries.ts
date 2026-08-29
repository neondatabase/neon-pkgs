/**
 * Search order for a directory `source` under esbuild. Shared by apply and
 * `neon function deploy --src`. `.mjs` is last so it never implies skip-esbuild.
 */
export const FUNCTION_SOURCE_ENTRIES = [
	"index.ts",
	"index.js",
	"index.mjs",
] as const;

export type FunctionSourceEntry = (typeof FUNCTION_SOURCE_ENTRIES)[number];

/** Filenames the Functions runtime imports from the archive root. */
export const FUNCTION_ARCHIVE_ENTRIES = ["index.mjs", "index.js"] as const;

export type FunctionArchiveEntry = (typeof FUNCTION_ARCHIVE_ENTRIES)[number];

/** `existing` is names the caller counted as files, so a directory named `index.ts` cannot win. */
export const pickFunctionSourceEntry = (
	existing: Iterable<string>,
): FunctionSourceEntry | undefined => {
	const names = existing instanceof Set ? existing : new Set(existing);
	return FUNCTION_SOURCE_ENTRIES.find((name) => names.has(name));
};

export const isFunctionArchiveEntry = (
	name: string,
): name is FunctionArchiveEntry => name === "index.mjs" || name === "index.js";
