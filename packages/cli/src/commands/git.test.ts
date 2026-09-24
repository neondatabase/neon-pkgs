import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { applyContext, readContextFile } from "../context.js";
import { cleanup, partitionBranchesToPrune, sync } from "./git.js";

const run = (args: string[], cwd: string) =>
	execFileSync("git", args, { cwd, stdio: "ignore" });

const initRepo = (dir: string, branches: string[]) => {
	run(["init", "-b", branches[0] ?? "main"], dir);
	run(["config", "user.email", "test@example.com"], dir);
	run(["config", "user.name", "Test"], dir);
	run(["config", "core.hooksPath", ".git/hooks"], dir);
	writeFileSync(join(dir, "README.md"), "# test\n");
	run(["add", "."], dir);
	run(["commit", "-m", "init"], dir);
	for (const branch of branches.slice(1)) {
		run(["branch", branch], dir);
	}
};

/** Fake apiClient exercising only what `cleanup` actually calls. */
const fakeApiClient = (
	branches: {
		id: string;
		name: string;
		default?: boolean;
		protected?: boolean;
	}[],
) => {
	const deleted: string[] = [];
	return {
		client: {
			listProjectBranches: async () => ({ data: { branches } }),
			deleteProjectBranch: async (
				_projectId: string,
				branchId: string,
			) => {
				deleted.push(branchId);
			},
		},
		deleted,
	};
};

describe("partitionBranchesToPrune", () => {
	const branches = [
		{ id: "br-main", name: "main", default: true },
		{ id: "br-prod", name: "production", protected: true },
		{ id: "br-x", name: "preview/x" },
		{ id: "br-y", name: "preview/y" },
		{ id: "br-live", name: "preview/live" }, // mapped from a still-present git branch
	];

	test("deletes only orphaned, non-default, non-protected branches", () => {
		const orphans = new Set([
			"main",
			"production",
			"preview/x",
			"preview/y",
		]);
		const { toDelete, skipped } = partitionBranchesToPrune(
			branches,
			orphans,
		);

		expect(toDelete.map((b) => b.name).sort()).toEqual([
			"preview/x",
			"preview/y",
		]);
		expect(skipped).toEqual([
			{ name: "main", reason: "default branch" },
			{ name: "production", reason: "protected" },
		]);
	});

	test("never touches a branch that is not orphaned", () => {
		const { toDelete } = partitionBranchesToPrune(
			branches,
			new Set(["preview/x"]),
		);
		expect(toDelete.map((b) => b.name)).toEqual(["preview/x"]);
		// `preview/live` is not in the orphan set → kept.
		expect(toDelete.some((b) => b.name === "preview/live")).toBe(false);
	});

	test("returns nothing to delete when there are no orphans", () => {
		const { toDelete, skipped } = partitionBranchesToPrune(
			branches,
			new Set(),
		);
		expect(toDelete).toEqual([]);
		expect(skipped).toEqual([]);
	});
});

describe("cleanup", () => {
	let repo: string;
	let contextFile: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "neon-git-cleanup-"));
		contextFile = join(repo, ".neon");
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("mapping-only mode prunes stale entries but never deletes Neon branches", async () => {
		initRepo(repo, ["main"]);
		applyContext(contextFile, {
			projectId: "proj",
			git: { map: { gone: "preview-gone" } },
		});
		const { client, deleted } = fakeApiClient([
			{ id: "br-1", name: "preview-gone" },
		]);

		const spy = vi.spyOn(process, "cwd").mockReturnValue(repo);
		try {
			await cleanup({
				apiClient: client as never,
				apiKey: "",
				apiHost: "",
				output: "json",
				contextFile,
				projectId: "proj",
			});
		} finally {
			spy.mockRestore();
		}

		expect(deleted).toEqual([]);
		expect(readContextFile(contextFile).git?.map).toEqual({});
	});

	test("never deletes a Neon branch still referenced by a kept mapping (shared target)", async () => {
		initRepo(repo, ["main"]);
		// Two git branches map to the same Neon branch; only one is stale.
		applyContext(contextFile, {
			projectId: "proj",
			git: { map: { main: "shared", gone: "shared" } },
		});
		const { client, deleted } = fakeApiClient([
			{ id: "br-1", name: "shared" },
		]);

		const spy = vi.spyOn(process, "cwd").mockReturnValue(repo);
		try {
			await cleanup({
				apiClient: client as never,
				apiKey: "",
				apiHost: "",
				output: "json",
				contextFile,
				projectId: "proj",
				pruneNeonBranches: true,
				yes: true,
			});
		} finally {
			spy.mockRestore();
		}

		expect(deleted).toEqual([]);
		// The stale `gone` mapping is dropped; `main` (still local, still valid) is kept.
		expect(readContextFile(contextFile).git?.map).toEqual({
			main: "shared",
		});
	});

	test("preserves the mapping when deletion is declined, so a retry is still possible", async () => {
		initRepo(repo, ["main"]);
		applyContext(contextFile, {
			projectId: "proj",
			git: { map: { gone: "preview-gone" } },
		});
		const { client, deleted } = fakeApiClient([
			{ id: "br-1", name: "preview-gone" },
		]);

		const spy = vi.spyOn(process, "cwd").mockReturnValue(repo);
		try {
			// `pruneNeonBranches: true` without `yes: true` and no TTY refuses non-interactively.
			await cleanup({
				apiClient: client as never,
				apiKey: "",
				apiHost: "",
				output: "json",
				contextFile,
				projectId: "proj",
				pruneNeonBranches: true,
			});
		} finally {
			spy.mockRestore();
		}

		expect(deleted).toEqual([]);
		// Declined/non-interactive: the mapping survives for a later retry.
		expect(readContextFile(contextFile).git?.map).toEqual({
			gone: "preview-gone",
		});
	});

	test("prunes the mapping once its Neon branch is actually deleted", async () => {
		initRepo(repo, ["main"]);
		applyContext(contextFile, {
			projectId: "proj",
			git: { map: { gone: "preview-gone" } },
		});
		const { client, deleted } = fakeApiClient([
			{ id: "br-1", name: "preview-gone" },
		]);

		const spy = vi.spyOn(process, "cwd").mockReturnValue(repo);
		try {
			await cleanup({
				apiClient: client as never,
				apiKey: "",
				apiHost: "",
				output: "json",
				contextFile,
				projectId: "proj",
				pruneNeonBranches: true,
				yes: true,
			});
		} finally {
			spy.mockRestore();
		}

		expect(deleted).toEqual(["br-1"]);
		expect(readContextFile(contextFile).git?.map).toEqual({});
	});

	test("refuses to delete when the active project differs from the one the map was recorded against", async () => {
		initRepo(repo, ["main"]);
		applyContext(contextFile, {
			projectId: "proj-a",
			git: { map: { gone: "preview-gone" } },
		});
		const { client, deleted } = fakeApiClient([
			{ id: "br-1", name: "preview-gone" },
		]);

		const spy = vi.spyOn(process, "cwd").mockReturnValue(repo);
		try {
			// `--project-id proj-b` (an override) differs from the `.neon`-recorded `proj-a`.
			await cleanup({
				apiClient: client as never,
				apiKey: "",
				apiHost: "",
				output: "json",
				contextFile,
				projectId: "proj-b",
				pruneNeonBranches: true,
				yes: true,
			});
		} finally {
			spy.mockRestore();
		}

		expect(deleted).toEqual([]);
		// Refused before ever calling the API — the mapping is untouched.
		expect(readContextFile(contextFile).git?.map).toEqual({
			gone: "preview-gone",
		});
	});

	test("persists each successful deletion's mapping removal even when a later deletion fails", async () => {
		initRepo(repo, ["main"]);
		applyContext(contextFile, {
			projectId: "proj",
			git: { map: { "gone-a": "preview-a", "gone-b": "preview-b" } },
		});
		const { client } = fakeApiClient([
			{ id: "br-a", name: "preview-a" },
			{ id: "br-b", name: "preview-b" },
		]);
		const deleteCalls: string[] = [];
		client.deleteProjectBranch = async (
			_projectId: string,
			branchId: string,
		) => {
			deleteCalls.push(branchId);
			if (branchId === "br-b") throw new Error("network blip");
		};

		const spy = vi.spyOn(process, "cwd").mockReturnValue(repo);
		try {
			await expect(
				cleanup({
					apiClient: client as never,
					apiKey: "",
					apiHost: "",
					output: "json",
					contextFile,
					projectId: "proj",
					pruneNeonBranches: true,
					yes: true,
				}),
			).rejects.toThrow(/network blip/);
		} finally {
			spy.mockRestore();
		}

		expect(deleteCalls).toEqual(["br-a", "br-b"]);
		// br-a deleted successfully -> its mapping is gone. br-b's delete failed -> its
		// mapping survives for a retry (not permanently lost).
		expect(readContextFile(contextFile).git?.map).toEqual({
			"gone-b": "preview-b",
		});
	});

	test("keeps a skipped (default/protected) branch's mapping", async () => {
		initRepo(repo, ["main"]);
		applyContext(contextFile, {
			projectId: "proj",
			git: { map: { gone: "prod" } },
		});
		const { client, deleted } = fakeApiClient([
			// `default: true` marks it as never-auto-deleted.
			{ id: "br-1", name: "prod", default: true },
		]);

		const spy = vi.spyOn(process, "cwd").mockReturnValue(repo);
		try {
			await cleanup({
				apiClient: client as never,
				apiKey: "",
				apiHost: "",
				output: "json",
				contextFile,
				projectId: "proj",
				pruneNeonBranches: true,
				yes: true,
			});
		} finally {
			spy.mockRestore();
		}

		expect(deleted).toEqual([]);
		expect(readContextFile(contextFile).git?.map).toEqual({ gone: "prod" });
	});
});

describe("sync (git.follow gate)", () => {
	let repo: string;
	let contextFile: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "neon-git-sync-"));
		contextFile = join(repo, ".neon");
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
		delete process.env.NEON_GIT_HOOK;
	});

	test("a hook-triggered run no-ops when this repo never ran `install` (git.follow unset)", async () => {
		initRepo(repo, ["main"]);
		applyContext(contextFile, { projectId: "proj" }); // no `git` block at all
		process.env.NEON_GIT_HOOK = "1";

		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repo);
		const errorSpy = vi
			.spyOn(process.stderr, "write")
			.mockReturnValue(true);
		try {
			await sync({
				apiClient: {} as never,
				apiKey: "",
				apiHost: "",
				output: "json",
				contextFile,
			});
		} finally {
			cwdSpy.mockRestore();
			errorSpy.mockRestore();
		}

		// No INFO/ERROR output at all — the function returned immediately, never touching
		// git branch resolution, checkout, or the (here-empty, would-throw) apiClient.
		expect(errorSpy).not.toHaveBeenCalled();
	});
});
