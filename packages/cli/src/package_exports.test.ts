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
 * `neon` publishes a `./dist/*` wildcard, so anything `tsc` emits is importable by path. That
 * is fine for the CLI's own modules and wrong for `src/_shared`, which is source copied in from
 * `shared/` and compiled as ours: `reuse-secrets.js` mints and revokes branch credentials, and
 * `credentials.js` reads them off disk. Removing `@neon/env/runtime` accomplishes nothing if
 * the same function is reachable at `neon/dist/_shared/env-core/reuse-secrets.js`.
 *
 * A `null` target blocks a subpath, and the more specific pattern wins over the wildcard, so
 * `./dist/commands/env.js` still resolves. Verified against Node: the blocked paths answer
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 */
describe("the published export map", () => {
	it("blocks the shared trees, which are implementation and not ours to publish", () => {
		expect(exportMap()["./dist/_shared/*"]).toBeNull();
	});

	it("still exposes the dist wildcard the block is carved out of", () => {
		// Without this the block is vacuous — nothing would have been reachable anyway.
		expect(exportMap()["./dist/*"]).toBe("./dist/*");
	});
});
