import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect } from "vitest";

import { test as originalTest } from "../test_utils/fixtures";

const TEST_TMP = mkdtempSync(join(tmpdir(), "neonctl-diff-"));

const test = originalTest.extend<{
	tmpContext: (label: string) => string;
}>({
	tmpContext: async ({}, use) => {
		await use((label) => {
			const dir = join(TEST_TMP, label);
			mkdirSync(dir, { recursive: true });
			return join(dir, ".neon");
		});
	},
});

describe("diff", () => {
	test("resolves a later-page context branch when comparing against page-one", async ({
		testCliCommand,
		tmpContext,
	}) => {
		const ctx = tmpContext("paged_pin");
		writeFileSync(
			ctx,
			JSON.stringify({
				orgId: "org-7",
				projectId: "proj-paged-branches",
				branch: "page-two",
			}),
		);
		const { stderr } = await testCliCommand(
			["diff", "page-one", "--context-file", ctx],
			{ snapshot: false },
		);
		expect(stderr).not.toContain("Branch page-two not found");
		expect(stderr).not.toContain("Available branches: page-one");
	});
});
