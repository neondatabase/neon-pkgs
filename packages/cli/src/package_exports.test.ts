import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const distDir = fileURLToPath(new URL("../dist", import.meta.url));

/** Every emitted `.js` file, or a failure saying the build has to run first. */
const emittedFiles = (): string[] => {
	if (!existsSync(distDir)) {
		throw new Error(
			`No ${distDir}. This spec asserts what the built package exposes, so run ` +
				"`pnpm --filter neon build` before it (`test` and `test:ci` already do).",
		);
	}
	const walk = (dir: string): string[] =>
		readdirSync(dir).flatMap((entry) => {
			const path = join(dir, entry);
			return statSync(path).isDirectory() ? walk(path) : [path];
		});
	return walk(distDir).filter((path) => path.endsWith(".js"));
};

/** The published `exports` map, or a failure naming what is missing. */
const exportMap = (): Record<string, unknown> => {
	const manifest: unknown = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	);
	if (!isRecord(manifest) || !isRecord(manifest.exports)) {
		throw new Error(
			"packages/cli/package.json has no `exports` object — the block asserted below " +
				"cannot exist, and every dist path is public.",
		);
	}
	return manifest.exports;
};

/**
 * `neon` publishes a `./dist/*` wildcard, so every emitted file is importable by path. That
 * is fine for the CLI's own modules and wrong for what the bundler puts in `dist/_chunks`,
 * which is where `@neon-internals/*` lands: `env-core/reuse-secrets` mints and revokes branch
 * credentials, and `cli-core/credentials` reads them off disk. Keeping those out of a published
 * package accomplishes nothing if the same function is reachable at
 * `neon/dist/_chunks/<name>-<hash>.js`.
 *
 * `_virtual` is the same judgement one level down: tsdown emits rolldown's shared runtime
 * helpers there, and how we compile is not a surface anyone should import.
 *
 * A `null` target blocks a subpath, and the more specific pattern wins over the wildcard, so
 * `./dist/commands/env.js` still resolves. Verified against Node: the blocked paths answer
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 */
describe("the published export map", () => {
	it("blocks the bundler's chunks, where the private internals are compiled to", () => {
		expect(exportMap()["./dist/_chunks/*"]).toBeNull();
	});

	it("blocks the bundler's runtime helpers, which are an artifact of how we compile", () => {
		expect(exportMap()["./dist/_virtual/*"]).toBeNull();
	});

	it("still exposes the dist wildcard the block is carved out of", () => {
		// Without this the block is vacuous — nothing would have been reachable anyway.
		expect(exportMap()["./dist/*"]).toBe("./dist/*");
	});
});

/**
 * The export map only decides what is *reachable*. These two check the build actually produced
 * what the map assumes, which is the half that breaks silently: moving an internals package into
 * `dependencies`, or widening `external` in `tsdown.config.ts`, leaves a bare specifier in `dist`
 * that no consumer can resolve, and puts the shared code outside `_chunks` where nothing blocks
 * it.
 */
describe("the built package", () => {
	it("resolves the private internals at build time, never at runtime", () => {
		// Anchored to the start of a line, because rolldown keeps JSDoc blocks and the internals
		// document themselves with `import … from "@neon-internals/…"` examples. A comment naming
		// the specifier is not an import of it.
		const importsInternals =
			/^\s*(?:import|export)\b[^'"`]*?from\s*["']@neon-internals\/|\bimport\s*\(\s*["']@neon-internals\//m;
		const leaking = emittedFiles().filter((path) =>
			importsInternals.test(readFileSync(path, "utf8")),
		);
		expect(leaking).toEqual([]);
	});

	it("puts everything the bundler shares into the one directory the map blocks", () => {
		const shared = emittedFiles().filter((path) =>
			/(^|[/\\])_(chunks|virtual)[/\\]/.test(path.slice(distDir.length)),
		);
		// Bundling `@neon-internals/*` into two entry points that both use it has to produce at
		// least one shared chunk; zero means the internals were inlined per-entry or externalized.
		expect(shared.length).toBeGreaterThan(0);
	});
});
