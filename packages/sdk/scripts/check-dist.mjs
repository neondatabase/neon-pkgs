/**
 * Guards the zero-dependency claim in `dist/`, straight after tsdown writes it.
 *
 * tsdown externalizes what `dependencies` lists and inlines everything else, so an
 * import of a devDependency from any file matched by the `entry` globs gets copied
 * into `dist/node_modules/`. That is how 743KB of vitest, chai, expect-type, loupe and
 * tinyrainbow reached the published tarball once: `client.test-d.ts` imports
 * `expectTypeOf`, and the entry globs excluded only `*.test.ts`.
 *
 * Both directions are failures, so both are checked: a bundled dependency (vendored
 * into `dist/node_modules/`) and an externalized one (a bare import left in `dist/`
 * that a consumer cannot resolve).
 */

import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(packageRoot, "dist");

const BUILTINS = new Set([
	...builtinModules,
	...builtinModules.map((name) => `node:${name}`),
]);

/**
 * `import … from "x"`, a bare `import "x"`, `export … from "x"`, and `import("x")`.
 *
 * Anchored at statement position because the JSDoc in this package contains `@example`
 * blocks that import `@neon/sdk` itself; matching those would block every release.
 */
const IMPORT_PATTERN =
	/^\s*(?:import|export)\b[^"';]*?from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/;

/** Drop comment lines so `@example` imports in JSDoc aren't read as real ones. */
function isCommentLine(line) {
	const trimmed = line.trimStart();
	return (
		trimmed.startsWith("*") ||
		trimmed.startsWith("//") ||
		trimmed.startsWith("/*")
	);
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

function isBareSpecifier(specifier) {
	return !specifier.startsWith(".") && !specifier.startsWith("/");
}

/** A bare specifier minus any subpath: `@scope/pkg/deep` → `@scope/pkg`. */
function packageOf(specifier) {
	const segments = specifier.split("/");
	return specifier.startsWith("@")
		? segments.slice(0, 2).join("/")
		: segments[0];
}

/**
 * The package a vendored file belongs to. Split on the *last* `node_modules/` so pnpm's
 * nested layout reports `chai` rather than `.pnpm`:
 * `dist/node_modules/.pnpm/chai@5.2.0/node_modules/chai/chai.js`
 */
function vendoredPackageOf(file) {
	const marker = "node_modules/";
	const tail = file.slice(file.lastIndexOf(marker) + marker.length);
	return packageOf(tail) || "unknown";
}

function findExternalImports(source) {
	const found = new Set();
	for (const line of source.split("\n")) {
		if (isCommentLine(line)) continue;
		const match = line.match(IMPORT_PATTERN);
		if (!match) continue;
		const specifier = match[1] ?? match[2] ?? match[3];
		if (!specifier || !isBareSpecifier(specifier)) continue;
		if (BUILTINS.has(specifier) || BUILTINS.has(packageOf(specifier))) {
			continue;
		}
		found.add(specifier);
	}
	return found;
}

const problems = [];

const manifest = JSON.parse(
	await readFile(join(packageRoot, "package.json"), "utf8"),
);
const runtimeDeps = Object.keys(manifest.dependencies ?? {});
if (runtimeDeps.length > 0) {
	problems.push(
		`package.json declares runtime dependencies, but ${manifest.name} is published as zero-dependency: ${runtimeDeps.join(", ")}`,
	);
}

const files = (await listFiles(distDir)).map((file) =>
	relative(packageRoot, file),
);
if (files.length === 0) {
	problems.push("dist/ is empty — run the build before this check.");
}

const vendored = files.filter((file) =>
	file.split("/").includes("node_modules"),
);
if (vendored.length > 0) {
	const packages = new Set(vendored.map(vendoredPackageOf));
	problems.push(
		`${vendored.length} file(s) from ${[...packages].sort().join(", ")} were bundled into dist/node_modules/. ` +
			"A file matched by the tsdown `entry` globs imports a devDependency — exclude it (see tsdown.config.ts).",
	);
}

const testArtifacts = files.filter((file) => /\.test(-d)?\./.test(file));
if (testArtifacts.length > 0) {
	problems.push(
		`test files were emitted into dist/: ${testArtifacts.join(", ")}. Widen the \`entry\` exclusions in tsdown.config.ts.`,
	);
}

for (const file of files.filter((file) => file.endsWith(".js"))) {
	const external = findExternalImports(
		await readFile(join(packageRoot, file), "utf8"),
	);
	if (external.size > 0) {
		problems.push(
			`${file} imports ${[...external].sort().join(", ")} at runtime, which consumers cannot resolve from a zero-dependency package.`,
		);
	}
}

if (problems.length > 0) {
	console.error(`\n${manifest.name}: dist/ is not publishable\n`);
	for (const problem of problems) console.error(`  • ${problem}`);
	console.error("");
	process.exit(1);
}

console.log(
	`${manifest.name}: dist/ is clean — ${files.length} files, no bundled or external dependencies.`,
);
