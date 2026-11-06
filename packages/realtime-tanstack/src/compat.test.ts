import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const TESTED_TANSTACK_DB_VERSION = "0.15.2";

describe("TanStack DB compatibility boundary", () => {
	it("tests the latest supported pre-1.0 version and declares the full range", async () => {
		const integrationPackage = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		) as {
			devDependencies: Record<string, string>;
			peerDependencies: Record<string, string>;
		};
		const installedPackage = JSON.parse(
			await readFile(
				new URL(
					"../node_modules/@tanstack/db/package.json",
					import.meta.url,
				),
				"utf8",
			),
		) as { version: string };

		expect(integrationPackage.devDependencies["@tanstack/db"]).toBe(
			TESTED_TANSTACK_DB_VERSION,
		);
		expect(integrationPackage.peerDependencies["@tanstack/db"]).toBe(
			">=0.9.0 <1.0.0",
		);
		expect(installedPackage.version).toBe(TESTED_TANSTACK_DB_VERSION);
	});
});
