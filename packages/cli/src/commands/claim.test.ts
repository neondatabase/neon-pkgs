import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimableCapabilities, findNeonConfig } from "./claim.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("claimable service requests", () => {
	it("always requests Postgres and maps the shared CLI service vocabulary", () => {
		expect(claimableCapabilities([])).toEqual(["postgres"]);
		expect(
			claimableCapabilities([
				"auth",
				"data-api",
				"functions",
				"object-storage",
				"ai-gateway",
			]),
		).toEqual([
			"postgres",
			"data_api",
			"auth",
			"storage",
			"functions",
			"ai_gateway",
		]);
	});

	it("does not suppress services that require claiming", () => {
		expect(
			claimableCapabilities([
				"object-storage",
				"functions",
				"ai-gateway",
			]),
		).toEqual(["postgres", "storage", "functions", "ai_gateway"]);
	});
});

describe("claimable neon.ts discovery", () => {
	it("finds the closest config while walking to the repository root", () => {
		const root = mkdtempSync(join(tmpdir(), "neon-claim-config-"));
		temporaryDirectories.push(root);
		writeFileSync(join(root, ".git"), "gitdir: test");
		const config = join(root, "neon.ts");
		writeFileSync(config, "export default {};");
		const nested = join(root, "packages", "app");
		mkdirSync(nested, { recursive: true });

		expect(findNeonConfig(nested)).toBe(config);
	});

	it("does not escape a repository that has no config", () => {
		const root = mkdtempSync(join(tmpdir(), "neon-claim-config-"));
		temporaryDirectories.push(root);
		writeFileSync(join(root, ".git"), "gitdir: test");
		const nested = join(root, "packages", "app");
		mkdirSync(nested, { recursive: true });

		expect(findNeonConfig(nested)).toBeUndefined();
	});
});
