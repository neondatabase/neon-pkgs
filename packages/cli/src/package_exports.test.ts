import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

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
