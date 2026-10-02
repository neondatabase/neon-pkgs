import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it } from "vitest";
import { formatHumanChunk } from "../human_table.js";
import { projectConfigPath } from "../project.js";
import { claimableCapabilities, claimCreateFields } from "./claim.js";

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
	it("uses the neon.ts in an unlinked directory, never a parent's", () => {
		const root = mkdtempSync(join(tmpdir(), "neon-claim-config-"));
		temporaryDirectories.push(root);
		writeFileSync(join(root, "neon.ts"), "export default {};");
		const nested = join(root, "packages", "app");
		mkdirSync(nested, { recursive: true });

		expect(projectConfigPath(nested)).toBeUndefined();
		writeFileSync(join(nested, "neon.ts"), "export default {};");
		expect(projectConfigPath(nested)).toBe(join(nested, "neon.ts"));
	});
});

describe("claim create table fields", () => {
	it("omits Denied Capabilities when nothing is denied", () => {
		expect(claimCreateFields([])).not.toContain("denied_capabilities");
		const out = formatHumanChunk({
			data: {
				project_id: "quiet-fog-12345678",
				branch_id: "br-quiet-fog-12345678",
				state: "unclaimed",
				project_expires_at: "2026-08-24T12:00:00.000Z",
				granted_capabilities: ["postgres"],
				denied_capabilities: [],
				env_file: "/tmp/.env.local",
			},
			fields: claimCreateFields([]),
			colorTitle: false,
		});
		expect(stripAnsi(out)).not.toContain("Denied");
		expect(stripAnsi(out)).toContain("Granted Capabilities");
	});

	it("keeps Denied Capabilities when a capability is denied", () => {
		const denied = [
			{
				capability: "functions",
				message:
					"functions is unavailable until the project is claimed",
			},
		];
		expect(claimCreateFields(denied)).toContain("denied_capabilities");
	});
});
