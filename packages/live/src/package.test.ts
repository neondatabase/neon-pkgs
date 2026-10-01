import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = dirname(
	fileURLToPath(new URL("../package.json", import.meta.url)),
);
const schemaSubpath = "schema/neon-live-query-capability-v1.schema.json";

interface PackResult {
	readonly files: readonly { readonly path: string }[];
}

describe("@neon/live package", () => {
	it("publishes the canonical query capability schema directly", () => {
		const manifest = JSON.parse(
			readFileSync(join(packageRoot, "package.json"), "utf8"),
		) as {
			readonly exports: Readonly<Record<string, string>>;
		};
		const exportedPath = manifest.exports[`./${schemaSubpath}`];

		expect(exportedPath).toBe(`./${schemaSubpath}`);
		expect(realpathSync(join(packageRoot, exportedPath as string))).toBe(
			realpathSync(join(packageRoot, schemaSubpath)),
		);

		const packOutput = execFileSync(
			"npm",
			["pack", "--dry-run", "--json", "--ignore-scripts"],
			{ cwd: packageRoot, encoding: "utf8" },
		);
		// Some npm versions print lifecycle output before the JSON despite
		// --ignore-scripts. The machine-readable result is always emitted last.
		const jsonStart = packOutput.lastIndexOf("\n[");
		const packed = JSON.parse(
			jsonStart === -1 ? packOutput : packOutput.slice(jsonStart + 1),
		) as readonly PackResult[];
		expect(packed).toHaveLength(1);
		expect(packed[0]?.files.map((file) => file.path)).toContain(
			schemaSubpath,
		);
	});
});
