import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = dirname(
	fileURLToPath(new URL("../package.json", import.meta.url)),
);
const schemaSubpath = "schema/neon-live-query-capability-v1.schema.json";

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

		const packDestination = mkdtempSync(join(tmpdir(), "neon-live-pack-"));
		try {
			execFileSync(
				"npm",
				[
					"pack",
					"--ignore-scripts",
					"--pack-destination",
					packDestination,
				],
				{ cwd: packageRoot, stdio: "ignore" },
			);
			const tarballs = readdirSync(packDestination).filter((path) =>
				path.endsWith(".tgz"),
			);
			expect(tarballs).toHaveLength(1);

			const files = execFileSync(
				"tar",
				["-tf", join(packDestination, tarballs[0] as string)],
				{ encoding: "utf8" },
			).split(/\r?\n/);
			expect(files).toContain(`package/${schemaSubpath}`);
		} finally {
			rmSync(packDestination, { recursive: true, force: true });
		}
	}, 30_000);
});
