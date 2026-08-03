/**
 * The checks behind `scripts/check-dist.mjs`, kept separate so they can be tested.
 *
 * `@neon/sdk` is published zero-dependency, and a dependency can reach a consumer two
 * ways. tsdown inlines whatever it was not told to externalize, so an import of a
 * devDependency from any file matched by the `entry` globs is copied into
 * `dist/node_modules/` — that is how 743KB of vitest, chai, expect-type, loupe and
 * tinyrainbow reached the published 1.4.0 tarball, because `client.test-d.ts` imports
 * `expectTypeOf` and the globs excluded only `*.test.ts`. Or it is externalized and left
 * as a bare import the consumer has to install.
 *
 * Manifest checks alone do not cover the second case. tsdown externalizes
 * `dependencies` ∪ `peerDependencies` (`tsdown/dist/src-XtWW9dvn.mjs`, `getPackageDeps`)
 * and also honours an explicit `external` option, which no manifest field records — so
 * the emitted code is read as well.
 *
 * That read uses a real ES module parser rather than a regex. A regex over emitted
 * JavaScript reports imports inside strings and comments, which already misfired once on
 * the `@example` blocks in this package's JSDoc, and misses imports spanning lines.
 * Non-literal dynamic imports (`import(someVariable)`) are out of scope: nothing can
 * resolve them statically, and tsdown cannot externalize a specifier it never sees.
 */

import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join, relative } from "node:path";
import { init, parse } from "es-module-lexer";

const BUILTINS = new Set([
	...builtinModules,
	...builtinModules.map((name) => `node:${name}`),
]);

/** Manifest fields that oblige a consumer to install something at runtime. */
const RUNTIME_DEPENDENCY_FIELDS = [
	"dependencies",
	"peerDependencies",
	"optionalDependencies",
];

/**
 * Path segments, treating both separators as one. `path.relative` yields backslashes on
 * Windows, where splitting on `/` alone silently matched nothing and let a `dist/` full of
 * vendored packages pass.
 */
export function segmentsOf(path) {
	return path.split(/[\\/]+/);
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
	return specifier.startsWith("@")
		? parts.slice(0, 2).join("/")
		: (parts[0] ?? "");
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

/**
 * Bare, non-builtin specifiers imported by an ES module — the ones a consumer would have
 * to install. Relative and builtin specifiers are fine, and a specifier the parser reports
 * as dynamic-but-not-literal is skipped rather than guessed at.
 */
export function externalImportsOf(source) {
	const [imports] = parse(source);
	const found = new Set();
	for (const entry of imports) {
		const specifier = entry.n;
		if (!specifier) continue;
		if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
		if (BUILTINS.has(specifier) || BUILTINS.has(packageOf(specifier))) {
			continue;
		}
		found.add(specifier);
	}
	return found;
}

async function listFiles(dir) {
	try {
		const entries = await readdir(dir, {
			withFileTypes: true,
			recursive: true,
		});
		return entries
			.filter((entry) => entry.isFile())
			.map((entry) => join(entry.parentPath ?? entry.path, entry.name));
	} catch (error) {
		// A missing dist is the same finding as an empty one, and reporting it beats an
		// ENOENT stack trace. Anything else is a real filesystem fault worth surfacing.
		if (error.code === "ENOENT") return [];
		throw error;
	}
}

/** Everything wrong with a built `dist/`, as messages. Empty means publishable. */
export async function inspectDist(packageRoot) {
	await init;
	const problems = [];

	const manifest = JSON.parse(
		await readFile(join(packageRoot, "package.json"), "utf8"),
	);
	for (const field of RUNTIME_DEPENDENCY_FIELDS) {
		const declared = Object.keys(manifest[field] ?? {});
		if (declared.length > 0) {
			problems.push(
				`package.json declares ${field}, but ${manifest.name} is published as zero-dependency: ${declared.join(", ")}.`,
			);
		}
	}

	const files = (await listFiles(join(packageRoot, "dist"))).map((file) =>
		relative(packageRoot, file),
	);
	if (files.length === 0) {
		problems.push(
			"dist/ is missing or empty — run the build before this check.",
		);
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

	for (const file of files.filter((file) => file.endsWith(".js"))) {
		const source = await readFile(join(packageRoot, file), "utf8");
		const external = externalImportsOf(source);
		if (external.size > 0) {
			problems.push(
				`${file} imports ${[...external].sort().join(", ")} at runtime, which a consumer of a zero-dependency package cannot resolve. Something was externalized rather than bundled — check \`dependencies\`, \`peerDependencies\`, and any \`external\` option in tsdown.config.ts.`,
			);
		}
	}

	return { name: manifest.name, fileCount: files.length, problems };
}
