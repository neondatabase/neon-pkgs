import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runCli } from "./helpers.js";

type Hit = { url: string; category: string; title: string };

const parseHits = (stdout: string): Hit[] => JSON.parse(stdout);

describe("neon docs search against neon.com site search", () => {
	it("returns neon.com pages with no credential", async () => {
		const result = await runCli(["docs", "search", "create branch"], {
			apiKey: null,
		});
		expect(result.code, result.stderr).toBe(0);
		const hits = parseHits(result.stdout);
		expect(hits.length).toBeGreaterThan(0);
		for (const hit of hits) {
			expect(new URL(hit.url).host).toBe("neon.com");
		}
	});

	it("searches with a broken stored credential", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "neon-e2e-broken-"));
		writeFileSync(join(configDir, "credentials.json"), "{not json");
		const result = await runCli(["docs", "search", "reset a branch"], {
			apiKey: null,
			configDir,
		});
		expect(result.code, result.stderr).toBe(0);
		expect(parseHits(result.stdout).length).toBeGreaterThan(0);
	});

	it("limits results to a category", async () => {
		const result = await runCli(
			[
				"docs",
				"search",
				"create branch",
				"--category",
				"api",
				"--limit",
				"5",
			],
			{ apiKey: null },
		);
		expect(result.code, result.stderr).toBe(0);
		const hits = parseHits(result.stdout);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.length).toBeLessThanOrEqual(5);
		expect(new Set(hits.map((hit) => hit.category))).toEqual(
			new Set(["api"]),
		);
	});
});
