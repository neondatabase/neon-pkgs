import type { ExternalPackageEntry, ResolvedExternalPackage } from "./types.js";

/**
 * The package a specifier belongs to, dropping any subpath: `sharp` from `sharp/lib/x`,
 * `@scope/pkg` from `@scope/pkg/sub`.
 *
 * Files are installed and traced one package at a time, so this is the unit the deploy
 * stages. A subpath narrows what esbuild leaves unresolved; it does not narrow what ships.
 */
export const externalPackageRoot = (specifier: string): string => {
	const segments = specifier.split("/");
	const keep = specifier.startsWith("@") ? 2 : 1;
	return segments.slice(0, keep).join("/");
};

/**
 * Normalize one authored entry into the shape every consumer reads.
 *
 * `includeFiles` defaults to **true**: the bare-string form is the one users reach for, and
 * it should produce a function that works. Turning it off is the deliberate gesture.
 */
export const normalizeExternalPackage = (
	entry: ExternalPackageEntry,
): ResolvedExternalPackage =>
	typeof entry === "string"
		? { name: entry, includeFiles: true }
		: { name: entry.name, includeFiles: entry.includeFiles !== false };

/**
 * The specifiers whose files a function ships, in declaration order and deduplicated.
 *
 * These are the specifiers **as authored**, subpath included, because that is what the trace
 * has to import. A package may export only a subpath — `exports: { "./native": … }` with no
 * `.` — in which case importing the root throws `ERR_PACKAGE_PATH_NOT_EXPORTED` and the
 * trace finds nothing. Use {@link externalPackageRoot} on these to get what to *install*,
 * which is always the whole package.
 */
export const packagesToStage = (
	entries: readonly ResolvedExternalPackage[],
): string[] => {
	const specifiers: string[] = [];
	for (const entry of entries) {
		if (!entry.includeFiles) continue;
		if (!specifiers.includes(entry.name)) specifiers.push(entry.name);
	}
	return specifiers;
};
