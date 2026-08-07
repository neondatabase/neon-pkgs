import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Locate an installed package by walking `node_modules` up from `fromDir`, the way Node
 * resolves.
 *
 * Deliberately not `require.resolve`. These packages routinely ship an `exports` map that
 * lists only `.`, which makes both `require.resolve(pkg)` and `require.resolve(pkg +
 * "/package.json")` throw `ERR_PACKAGE_PATH_NOT_EXPORTED` even though the package is right
 * there on disk. `sharp` is one of them, so a resolver-based lookup fails on exactly the
 * package this whole feature exists for.
 */
export function findPackageDir(
	fromDir: string,
	name: string,
): string | undefined {
	let current = resolve(fromDir);
	for (;;) {
		const candidate = join(current, "node_modules", ...name.split("/"));
		try {
			if (statSync(candidate).isDirectory()) return candidate;
		} catch {
			// Not at this level; keep walking up.
		}
		const parent = resolve(current, "..");
		if (parent === current) return undefined;
		current = parent;
	}
}

/** A package's parsed manifest, or `undefined` when it is absent or unparseable. */
export function readPackageManifest(
	dir: string,
): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(join(dir, "package.json"), "utf8"),
		);
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * The version of `name` as installed under `fromDir`, or `undefined` when it is not
 * installed. Callers treat `undefined` as "cannot pin" and must say so rather than quietly
 * installing whatever the registry calls latest.
 */
export function installedPackageVersion(
	fromDir: string,
	name: string,
): string | undefined {
	const dir = findPackageDir(fromDir, name);
	if (dir === undefined) return undefined;
	const version = readPackageManifest(dir)?.version;
	return typeof version === "string" ? version : undefined;
}
