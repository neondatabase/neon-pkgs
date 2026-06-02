import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	applyContextFileFields,
	findContextFilePath,
	formatContextFile,
} from "./context-file.js";
import { ConfigLoadError } from "./errors.js";
import { makeTempRepo } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

function setup(files: Record<string, string | null>) {
	const repo = makeTempRepo(files);
	cleanups.push(repo.cleanup);
	return repo.root;
}

describe("findContextFilePath", () => {
	test("returns the absolute path of .neon/project.json when present", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId: "p1" }),
		});
		const found = findContextFilePath(root);
		expect(found).toBe(join(root, ".neon", "project.json"));
	});

	test("returns the absolute path of .neon (neonctl-style) when present", () => {
		const root = setup({
			"package.json": "{}",
			".neon": JSON.stringify({ projectId: "p1" }),
		});
		const found = findContextFilePath(root);
		expect(found).toBe(join(root, ".neon"));
	});

	test("returns null when no context file is found", () => {
		const root = setup({ "package.json": "{}" });
		expect(findContextFilePath(root)).toBeNull();
	});
});

describe("formatContextFile", () => {
	test("emits keys in projectId / orgId / branchId order with a trailing newline", () => {
		expect(
			formatContextFile({
				projectId: "p1",
				orgId: "o1",
				branchId: "br-1",
			}),
		).toBe(
			'{\n  "projectId": "p1",\n  "orgId": "o1",\n  "branchId": "br-1"\n}\n',
		);
	});

	test("omits orgId and branchId when undefined", () => {
		expect(formatContextFile({ projectId: "p1" })).toBe(
			'{\n  "projectId": "p1"\n}\n',
		);
	});
});

describe("applyContextFileFields", () => {
	test("returns status: updated and merges new fields, preserving other keys", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "p1",
				orgId: "o1",
				neonctlMeta: "preserved",
			}),
		});
		const path = join(root, ".neon", "project.json");
		const result = applyContextFileFields(path, {
			projectId: "p1",
			orgId: "o1",
			branchId: "br-new",
		});

		expect(result).toEqual({ status: "updated" });
		const reread = JSON.parse(readFileSync(path, "utf-8"));
		expect(reread).toEqual({
			projectId: "p1",
			orgId: "o1",
			neonctlMeta: "preserved",
			branchId: "br-new",
		});
	});

	test("overrides an existing branchId", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "p1",
				branchId: "br-old",
			}),
		});
		const path = join(root, ".neon", "project.json");
		applyContextFileFields(path, {
			projectId: "p1",
			branchId: "br-new",
		});

		const reread = JSON.parse(readFileSync(path, "utf-8"));
		expect(reread.branchId).toBe("br-new");
	});

	test("throws ConfigLoadError when the file is not JSON", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": "not json {{",
		});
		const path = join(root, ".neon", "project.json");
		expect(() =>
			applyContextFileFields(path, {
				projectId: "p1",
				branchId: "br-new",
			}),
		).toThrow(ConfigLoadError);
	});

	test("throws ConfigLoadError when the JSON value is not an object", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": "[1, 2, 3]",
		});
		const path = join(root, ".neon", "project.json");
		expect(() =>
			applyContextFileFields(path, {
				projectId: "p1",
				branchId: "br-new",
			}),
		).toThrow(ConfigLoadError);
	});

	test("returns status: write-failed when the file is read-only", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId: "p1" }),
		});
		const path = join(root, ".neon", "project.json");
		// chmod 0o444 — owner can read/stat but cannot write.
		chmodSync(path, 0o444);
		// Restore perms in cleanup so the temp-dir teardown can delete the file.
		cleanups.push(() => {
			try {
				chmodSync(path, 0o644);
			} catch {
				/* best effort */
			}
		});

		const result = applyContextFileFields(path, {
			projectId: "p1",
			branchId: "br-new",
		});
		expect(result.status).toBe("write-failed");
		if (result.status === "write-failed") {
			expect(result.error).toMatch(/EACCES|permission denied/i);
		}
	});
});
