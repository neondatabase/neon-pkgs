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
 *
 * `throwIfNoEntry: false` rather than a `try`/`catch`: a missing directory is the expected
 * signal to keep walking, but a permission or loop error is a real fault and must propagate
 * instead of being read as "not here" — that silently returns an ancestor's copy of the
 * package, which is a different version than the one being deployed.
 */
export function findPackageDir(
	fromDir: string,
	name: string,
): string | undefined {
	let current = resolve(fromDir);
	for (;;) {
		const candidate = join(current, "node_modules", ...name.split("/"));
		const stat = statSync(candidate, { throwIfNoEntry: false });
		if (stat?.isDirectory()) return candidate;
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
