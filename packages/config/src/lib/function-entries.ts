/**
 * Entry filenames a directory `source` is searched for, in order, when the function is
 * bundled with esbuild. First match wins. Shared by `neon.ts` apply and
 * `neon function deploy --src` so the two paths cannot drift.
 *
 * `.mjs` is last on purpose: a folder that also has `index.js` is bundled from the
 * JavaScript file, not treated as already-built ESM. Skip-esbuild is `bundler: "none"` /
 * `--no-bundle`, never inferred from the extension.
 */
export const FUNCTION_SOURCE_ENTRIES = [
	"index.ts",
	"index.js",
	"index.mjs",
] as const;

export type FunctionSourceEntry = (typeof FUNCTION_SOURCE_ENTRIES)[number];

/**
 * Entry filenames the Functions runtime imports from the archive root. A `"none"` bundle
 * that carries neither cannot be invoked.
 */
export const FUNCTION_ARCHIVE_ENTRIES = ["index.mjs", "index.js"] as const;

export type FunctionArchiveEntry = (typeof FUNCTION_ARCHIVE_ENTRIES)[number];

/**
 * First {@link FUNCTION_SOURCE_ENTRIES} name that appears in `existing`. Pure: the
 * caller decides what "exists" (a file, not a directory of the same name).
 */
export const pickFunctionSourceEntry = (
	existing: Iterable<string>,
): FunctionSourceEntry | undefined => {
	const names = existing instanceof Set ? existing : new Set(existing);
	return FUNCTION_SOURCE_ENTRIES.find((name) => names.has(name));
};

export const isFunctionArchiveEntry = (
	name: string,
): name is FunctionArchiveEntry => name === "index.mjs" || name === "index.js";
