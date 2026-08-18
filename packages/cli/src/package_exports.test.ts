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
 * `_virtual` is the same judgement applied to the build tool: tsdown emits rolldown's shared
 * runtime helpers there, and how we compile is not a surface anyone should import.
 *
 * A `null` target blocks a subpath, and the more specific pattern wins over the wildcard, so
 * `./dist/commands/env.js` still resolves. Verified against Node: the blocked paths answer
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 */
describe("the published export map", () => {
	it("blocks the bundler's chunks, where the private internals are compiled to", () => {
		expect(exportMap()["./dist/_chunks/*"]).toBeNull();
	});

	it("still blocks the path the internals used to be copied to", () => {
		// Nothing emits `dist/_shared` any more, so this matches nothing today. It stays because
		// recreating `src/_shared` is the habit of anyone who worked here before, and the entry
		// glob is `src/**/*.ts` — the directory would compile straight back into a public subpath.
		expect(exportMap()["./dist/_shared/*"]).toBeNull();
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
 * what the map assumes, which is the half that breaks silently: widening `external` in
 * `tsdown.config.ts` leaves a bare specifier in `dist` that no consumer can resolve, and puts the
 * shared code outside `_chunks`, where nothing blocks it.
 */
describe("the built package", () => {
	it("resolves the private internals at build time, never at runtime", () => {
		// Anchored to the start of a line, because rolldown keeps JSDoc blocks and the internals
		// document themselves with `import … from "@neon-internals/…"` examples. A comment naming
		// the specifier is not an import of it. Side-effect imports have no `from`.
		const importsInternals =
			/^\s*(?:import|export)\b[^'"`]*?from\s*["']@neon-internals\/|^\s*import\s*["']@neon-internals\/|\bimport\s*\(\s*["']@neon-internals\//m;
		const leaking = emittedFiles().filter((path) =>
			importsInternals.test(readFileSync(path, "utf8")),
		);
		expect(leaking).toEqual([]);
	});

	it("keeps the internals' code inside the directory the map blocks", () => {
		// A name the CLI reaches only through `@neon-internals/env-core`, so wherever it is
		// declared is where that package's code ended up. Asserting that some chunk exists would
		// pass on the unrelated `psql` and `cmd_pipeline` chunks this package already produces.
		// Matched where it is *declared*, not merely called, so the modules that import it are not
		// counted as holding it.
		const declaresIt = emittedFiles().filter((path) =>
			/\b(?:function|const|let|var|class)\s+fetchEnvReusingSecrets\b/.test(
				readFileSync(path, "utf8"),
			),
		);
		expect(declaresIt).not.toEqual([]);
		for (const path of declaresIt) {
			expect(path.slice(distDir.length)).toMatch(/^[/\\]_chunks[/\\]/);
		}
	});
});

/**
 * `devDependencies` is not what inlines the internals — `external` in `tsdown.config.ts` is. What
 * `devDependencies` does is keep them out of the published manifest, and that is the half npm
 * enforces: a `dependencies` entry naming an unpublished package makes `npm install neon` fail,
 * while the code would still be bundled and the build would still look fine.
 */
describe("the published manifests", () => {
	// Both packages that bundle the internals, checked here rather than one each, because the
	// invariant is about the internals staying unpublishable and not about either consumer.
	it.each([
		"../package.json",
		"../../env/package.json",
	])("%s never declares a private internals package as a runtime dependency", (relative) => {
		const manifest: unknown = JSON.parse(
			readFileSync(new URL(relative, import.meta.url), "utf8"),
		);
		if (!isRecord(manifest))
			throw new Error(`${relative} is not an object.`);
		for (const field of [
			"dependencies",
			"optionalDependencies",
			"peerDependencies",
		]) {
			const declared = manifest[field];
			const names = isRecord(declared) ? Object.keys(declared) : [];
			expect(
				names.filter((name) => name.startsWith("@neon-internals/")),
			).toEqual([]);
		}
	});

	it.each([
		"../package.json",
		"../../env/package.json",
	])("%s lists @napi-rs/keyring as optional, not required", (relative) => {
		const manifest: unknown = JSON.parse(
			readFileSync(new URL(relative, import.meta.url), "utf8"),
		);
		if (!isRecord(manifest))
			throw new Error(`${relative} is not an object.`);
		const optional = manifest.optionalDependencies;
		const required = manifest.dependencies;
		expect(
			isRecord(optional) ? optional["@napi-rs/keyring"] : undefined,
		).toEqual(expect.any(String));
		expect(
			isRecord(required) ? required["@napi-rs/keyring"] : undefined,
		).toBeUndefined();
	});
});

describe("the keyring adapter stays a runtime load", () => {
	it("does not emit a literal @napi-rs/keyring specifier", () => {
		const literal = emittedFiles().filter((path) =>
			readFileSync(path, "utf8").includes("@napi-rs/keyring"),
		);
		expect(literal).toEqual([]);
	});
});
