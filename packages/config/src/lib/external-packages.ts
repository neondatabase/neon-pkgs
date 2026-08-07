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
 * The distinct packages whose files a function ships, in declaration order.
 *
 * Subpath entries collapse onto their package root, so declaring both `pkg` and `pkg/sub`
 * stages `pkg` once. The schema has already rejected any pair that disagrees about
 * `includeFiles`, so collapsing here cannot silently pick a side.
 */
export const packagesToStage = (
	entries: readonly ResolvedExternalPackage[],
): string[] => {
	const roots: string[] = [];
	for (const entry of entries) {
		if (!entry.includeFiles) continue;
		const root = externalPackageRoot(entry.name);
		if (!roots.includes(root)) roots.push(root);
	}
	return roots;
};
