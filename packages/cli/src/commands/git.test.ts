import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
	applyContext,
	isUnfollowedGitHookSync,
	readContextFile,
} from "../context.js";
import {
	cleanup,
	install,
	partitionBranchesToPrune,
	status,
	sync,
} from "./git.js";

/** Capture writer output (the writer respects `props.out`). */
const captureOut = (): { stream: PassThrough; read: () => string } => {
	const stream = new PassThrough();
	let buffer = "";
	stream.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
	});
	return { stream, read: () => buffer };
};

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
			await expect(
				cleanup({
					apiClient: client as never,
					apiKey: "",
					apiHost: "",
					output: "json",
					contextFile,
					projectId: "proj-b",
					pruneNeonBranches: true,
					yes: true,
				}),
			).rejects.toThrow(/recorded against project proj-a/);
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

	test("never removes a not-yet-attempted branch's mapping while an earlier one is still being processed", async () => {
		// A succeeds, B fails, C hasn't been attempted at all yet when B fails. C's mapping
		// must still be on disk at that moment — an interruption right after B's failure
		// (before C ever runs) must not have already lost it.
		initRepo(repo, ["main"]);
		applyContext(contextFile, {
			projectId: "proj",
			git: {
				map: {
					"gone-a": "preview-a",
					"gone-b": "preview-b",
					"gone-c": "preview-c",
				},
			},
		});
		const { client } = fakeApiClient([
			{ id: "br-a", name: "preview-a" },
			{ id: "br-b", name: "preview-b" },
			{ id: "br-c", name: "preview-c" },
		]);
		let mapWhenBFailed: Record<string, string> | undefined;
		client.deleteProjectBranch = async (
			_projectId: string,
			branchId: string,
		) => {
			if (branchId === "br-b") {
				mapWhenBFailed = readContextFile(contextFile).git?.map;
				throw new Error("network blip");
			}
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

		// At the moment B failed, A (processed first) was already pruned, but C (not yet
		// attempted) still had its mapping — never dropped ahead of its own outcome.
		expect(mapWhenBFailed).toEqual({
			"gone-b": "preview-b",
			"gone-c": "preview-c",
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

	test("install refuses when no project is linked at the repo root (never plants a shadowing .neon)", () => {
		// The project is linked at an ANCESTOR directory only — this repo has no `.neon` of
		// its own. `install` must refuse rather than create a bare `{ git: {...} }` file
		// here: that new, closer file would shadow the ancestor's link for every other
		// command's normal (walk-up) context resolution.
		const outer = mkdtempSync(join(tmpdir(), "neon-git-noproject-"));
		const ancestorFile = join(outer, ".neon");
		const nestedRepo = join(outer, "nested-repo");
		try {
			applyContext(ancestorFile, { projectId: "ancestor-project" });
			mkdirSync(nestedRepo, { recursive: true });
			initRepo(nestedRepo, ["main"]);

			const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(nestedRepo);
			try {
				expect(() =>
					install({
						apiClient: {} as never,
						apiKey: "",
						apiHost: "",
						output: "json",
						contextFile: ancestorFile,
					}),
				).toThrow(/No project linked at the repository root/);
			} finally {
				cwdSpy.mockRestore();
			}

			// No `.neon` was created at the repo root, and the ancestor's own file (which
			// `install` never touches) still resolves normally for other commands.
			expect(existsSync(join(nestedRepo, ".neon"))).toBe(false);
			expect(readContextFile(ancestorFile)).toEqual({
				projectId: "ancestor-project",
			});
		} finally {
			rmSync(outer, { recursive: true, force: true });
		}
	});

	test("install writes git.follow to THIS repo's own root .neon, not an ancestor's", () => {
		// `repo` (the git repository under test) is nested one level inside a dedicated
		// parent that holds an unrelated `.neon` with `git.follow: true` already set. The
		// CLI's normal context-enrichment middleware would walk up from `repo` and resolve
		// `props.contextFile` to *that* ancestor path (simulated here by passing it
		// explicitly) — install must ignore it and write to this repo's own root instead.
		const outer = mkdtempSync(join(tmpdir(), "neon-git-ancestor-"));
		const ancestorFile = join(outer, ".neon");
		const nestedRepo = join(outer, "nested-repo");
		try {
			writeFileSync(
				ancestorFile,
				JSON.stringify({
					projectId: "unrelated-project",
					git: { follow: true },
				}),
			);
			mkdirSync(nestedRepo, { recursive: true });
			initRepo(nestedRepo, ["main"]);
			// A prior `neon link` at the repo root — `install` requires this to exist (never
			// plants a bare file that could shadow the ancestor's link for other commands).
			applyContext(join(nestedRepo, ".neon"), {
				projectId: "nested-project",
			});

			const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(nestedRepo);
			try {
				install({
					apiClient: {} as never,
					apiKey: "",
					apiHost: "",
					output: "json",
					contextFile: ancestorFile,
				});
			} finally {
				cwdSpy.mockRestore();
			}

			// install wrote follow into THIS repo's own root .neon (creating it) — never
			// into the ancestor's file it was handed via `contextFile`.
			expect(readContextFile(join(nestedRepo, ".neon")).git?.follow).toBe(
				true,
			);

			// The opt-in check (and thus the auth middleware) now agrees: a hook-triggered
			// sync in this repo is no longer unfollowed.
			process.env.NEON_GIT_HOOK = "1";
			expect(
				isUnfollowedGitHookSync({ _: ["git", "sync"] }, nestedRepo),
			).toBe(false);
		} finally {
			rmSync(outer, { recursive: true, force: true });
		}
	});
});

describe("status", () => {
	let repo: string;
	let contextFile: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "neon-git-status-"));
		contextFile = join(repo, ".neon");
		initRepo(repo, ["main"]);
		applyContext(contextFile, {
			projectId: "proj",
			git: { follow: true, map: { "feature-a": "preview-feature-a" } },
		});
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("respects --output json (not just the human table)", () => {
		const { stream, read } = captureOut();
		const props = {
			apiClient: {} as never,
			apiKey: "",
			apiHost: "",
			output: "json" as const,
			contextFile,
			out: stream,
		};
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repo);
		try {
			status(props);
		} finally {
			cwdSpy.mockRestore();
		}

		expect(JSON.parse(read())).toEqual({
			gitBranch: "main",
			hookInstalled: false,
			followOnCheckout: true,
			mappedNeonBranch: null,
			mappings: { "feature-a": "preview-feature-a" },
		});
	});

	test("respects --output yaml", () => {
		const { stream, read } = captureOut();
		const props = {
			apiClient: {} as never,
			apiKey: "",
			apiHost: "",
			output: "yaml" as const,
			contextFile,
			out: stream,
		};
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repo);
		try {
			status(props);
		} finally {
			cwdSpy.mockRestore();
		}

		expect(read()).toContain("gitBranch: main");
		expect(read()).toContain("feature-a: preview-feature-a");
	});

	test("throws when not inside a git repository", () => {
		const outside = mkdtempSync(join(tmpdir(), "neon-git-status-outside-"));
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(outside);
		try {
			expect(() =>
				status({
					apiClient: {} as never,
					apiKey: "",
					apiHost: "",
					output: "json",
					contextFile,
				}),
			).toThrow(/Not inside a git repository/);
		} finally {
			cwdSpy.mockRestore();
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
