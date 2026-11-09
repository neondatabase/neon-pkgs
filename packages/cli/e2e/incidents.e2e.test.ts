import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NeonIncidentsReport } from "@neon/sdk";
import { describe, expect, it } from "vitest";

import { runCli } from "./helpers.js";

describe("neon incidents against neonstatus.com", () => {
	it("reports the status page with no credential", async () => {
		const result = await runCli(["incidents"], { apiKey: null });
		expect(result.code, result.stderr).toBe(0);
		const report: NeonIncidentsReport = JSON.parse(result.stdout);
		expect(report.status_page_url).toBe("https://neonstatus.com");
		expect(typeof report.status).toBe("string");
		expect(Array.isArray(report.incidents)).toBe(true);
		expect(Array.isArray(report.maintenance)).toBe(true);
	});

	it("ignores a broken stored credential and .neon file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "neon-e2e-incidents-"));
		writeFileSync(join(dir, "credentials.json"), "{not json");
		const contextFile = join(dir, ".neon");
		writeFileSync(contextFile, "{not json");
		const result = await runCli(["incidents"], {
			apiKey: null,
			configDir: dir,
			contextFile,
		});
		expect(result.code, result.stderr).toBe(0);
	});
});
