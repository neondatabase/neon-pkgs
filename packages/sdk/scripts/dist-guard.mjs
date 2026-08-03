/**
 * The checks behind `scripts/check-dist.mjs`, kept separate so they can be tested.
 *
 * `@neon/sdk` is published zero-dependency. tsdown externalizes what `dependencies`
 * declares and inlines everything else, so an import of a devDependency from any file
 * matched by the `entry` globs is copied into `dist/node_modules/`. That is how 743KB of
 * vitest, chai, expect-type, loupe and tinyrainbow reached the published 1.4.0 tarball:
 * `client.test-d.ts` imports `expectTypeOf`, and the globs excluded only `*.test.ts`.
 *
 * Both directions of that mistake are bounded by the two checks together. A bundled
 * dependency shows up under `dist/node_modules/`. A dependency left external can only be
 * one tsdown was told to externalize, which means it appears in `dependencies` — and a
 * non-empty `dependencies` map fails on its own. Deliberately not attempted: scanning
 * `dist` for bare imports. A regex over emitted JavaScript reports imports inside strings
 * and comments and misses multiline and computed ones, and a release gate that blocks a
 * good release is worse than the redundancy it removes.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Path segments, separator-normalized so the checks behave the same on Windows. */
export function segmentsOf(path) {
	return path.split(sep).join("/").split("/");
}

/** True when a file inside `dist` came from a package rather than from `src`. */
export function isVendored(path) {
	return segmentsOf(path).includes("node_modules");
}

/** True for an emitted test artifact, covering both `*.test.*` and `*.test-d.*`. */
export function isTestArtifact(path) {
	return /\.test(-d)?\./.test(segmentsOf(path).at(-1) ?? "");
}

/** A bare specifier minus any subpath: `@scope/pkg/deep` → `@scope/pkg`. */
export function packageOf(specifier) {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * The package a vendored file belongs to. Reads from the *last* `node_modules` segment so
 * pnpm's nested layout reports `chai` rather than `.pnpm`:
 * `dist/node_modules/.pnpm/chai@5.2.0/node_modules/chai/chai.js`
 */
export function vendoredPackageOf(path) {
	const parts = segmentsOf(path);
	const last = parts.lastIndexOf("node_modules");
	return packageOf(parts.slice(last + 1).join("/")) || "unknown";
}

async function listFiles(dir) {
	const entries = await readdir(dir, {
		withFileTypes: true,
		recursive: true,
	});
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

/** Everything wrong with a built `dist/`, as messages. Empty means publishable. */
export async function inspectDist(packageRoot) {
	const problems = [];

	const manifest = JSON.parse(
		await readFile(join(packageRoot, "package.json"), "utf8"),
	);
	const runtimeDeps = Object.keys(manifest.dependencies ?? {});
	if (runtimeDeps.length > 0) {
		problems.push(
			`package.json declares runtime dependencies, but ${manifest.name} is published as zero-dependency: ${runtimeDeps.join(", ")}. Anything listed here is also left external in dist/, so consumers would have to install it.`,
		);
	}

	const files = (await listFiles(join(packageRoot, "dist"))).map((file) =>
		relative(packageRoot, file),
	);
	if (files.length === 0) {
		problems.push("dist/ is empty — run the build before this check.");
	}

	const vendored = files.filter(isVendored);
	if (vendored.length > 0) {
		const packages = [...new Set(vendored.map(vendoredPackageOf))].sort();
		problems.push(
			`${vendored.length} file(s) from ${packages.join(", ")} were bundled into dist/node_modules/. A file matched by the tsdown \`entry\` globs imports a devDependency — exclude it (see tsdown.config.ts).`,
		);
	}

	const testArtifacts = files.filter(isTestArtifact);
	if (testArtifacts.length > 0) {
		problems.push(
			`test files were emitted into dist/: ${testArtifacts.join(", ")}. Widen the \`entry\` exclusions in tsdown.config.ts. Note that \`!src/**/*.test.*\` does not match \`*.test-d.ts\`.`,
		);
	}

	return { name: manifest.name, fileCount: files.length, problems };
}
