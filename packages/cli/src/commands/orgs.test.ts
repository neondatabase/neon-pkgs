import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect } from "vitest";

import { test } from "../test_utils/fixtures";
import { planName } from "./orgs";

describe("orgs", () => {
	test("list", async ({ testCliCommand }) => {
		await testCliCommand(["orgs", "list"]);
	});

	const linkedTo = (orgId: string) => {
		const path = join(mkdtempSync(join(tmpdir(), "neon-orgs-")), ".neon");
		writeFileSync(path, JSON.stringify({ orgId }));
		return path;
	};

	test("list marks the linked org and shows plans in the table", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["orgs", "list", "--context-file", linkedTo("org-linked-123")],
			{ output: "table", mockDir: "orgs-plans" },
		);
	});

	test("list keeps JSON free of the marker", async ({ testCliCommand }) => {
		const linked = await testCliCommand(
			["orgs", "list", "--context-file", linkedTo("org-linked-123")],
			{ output: "json", mockDir: "orgs-plans", snapshot: false },
		);
		const unlinked = await testCliCommand(["orgs", "list"], {
			output: "json",
			mockDir: "orgs-plans",
			snapshot: false,
		});
		expect(linked.stdout).toBe(unlinked.stdout);
		expect(linked.stdout).not.toContain("[current]");
	});

	test("planName turns plan ids into names", () => {
		expect(planName("free_v3")).toBe("Free");
		expect(planName("launch")).toBe("Launch");
		expect(planName("free_extended")).toBe("Free Extended");
		expect(planName(undefined)).toBe("");
	});
});
