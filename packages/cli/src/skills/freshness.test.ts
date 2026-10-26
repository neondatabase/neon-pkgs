import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	formatSkillsNotice,
	type LockedSkill,
	parseSkillsCheckCache,
	parseSkillsLock,
	planSkillsCheck,
	type RemoteFolder,
	readLockedSkills,
	type SkillsTelemetryScope,
	skillContentHash,
	skillStatus,
	skillsTelemetry,
} from "./freshness.js";

const TREE = "a".repeat(40);
const NEW_TREE = "b".repeat(40);
const CONTENT = "c".repeat(64);
const NEW_CONTENT = "d".repeat(64);
const KEY = "neondatabase/agent-skills:skills/neon";

const neon = (
	scope: LockedSkill["scope"],
	hash: string,
	hashKind: LockedSkill["hashKind"] = scope === "global" ? "tree" : "content",
): LockedSkill => ({
	scope,
	skill: "neon",
	source: "neondatabase/agent-skills",
	folder: "skills/neon",
	hash,
	hashKind,
	pinned: false,
});

const PINNED_AUTH = {
	skill: "neon-auth",
	source: "neondatabase/agent-skills",
	folder: "skills/neon-auth",
	pinned: true,
};

describe("parseSkillsLock", () => {
	const lock = (neonEntry: Record<string, string>) =>
		JSON.stringify({
			version: 3,
			skills: {
				neon: {
					source: "neondatabase/agent-skills",
					skillPath: "skills/neon/SKILL.md",
					...neonEntry,
				},
				"neon-auth": {
					source: "neondatabase/agent-skills",
					skillPath: "skills/neon-auth/SKILL.md",
					ref: "v1",
					skillFolderHash: TREE,
					computedHash: CONTENT,
				},
				other: {
					source: "vercel-labs/agent-skills",
					skillPath: "skills/x/SKILL.md",
					skillFolderHash: TREE,
					computedHash: CONTENT,
				},
			},
		});

	test("reads the hash field each scope's lock writes, and marks pinned entries", () => {
		const both = lock({ skillFolderHash: TREE, computedHash: CONTENT });
		expect(parseSkillsLock(both, "global")).toEqual([
			neon("global", TREE),
			{ ...PINNED_AUTH, scope: "global", hash: TREE, hashKind: "tree" },
		]);
		expect(parseSkillsLock(both, "project")).toEqual([
			neon("project", CONTENT),
			{
				...PINNED_AUTH,
				scope: "project",
				hash: CONTENT,
				hashKind: "content",
			},
		]);
	});

	test("treats a 64-character global hash as a content hash", () => {
		expect(
			parseSkillsLock(lock({ skillFolderHash: CONTENT }), "global")[0],
		).toEqual(neon("global", CONTENT, "content"));
	});

	test("skips names that could carry terminal controls", () => {
		const raw = JSON.stringify({
			version: 1,
			skills: {
				"neon\u001b]52;c;cHJvb2Y=\u0007\nWARNING: forged": {
					source: "neondatabase/agent-skills",
					skillPath: "skills/neon/SKILL.md",
					computedHash: CONTENT,
				},
			},
		});
		expect(parseSkillsLock(raw, "project")).toEqual([]);
	});

	test("throws on a lock that is not JSON", () => {
		expect(() => parseSkillsLock("{", "project")).toThrow();
	});
});

describe("readLockedSkills", () => {
	test("leaves pinned skills out of the update check", () => {
		const dir = mkdtempSync(join(tmpdir(), "neon-skills-lock-"));
		try {
			const path = join(dir, "skills-lock.json");
			writeFileSync(
				path,
				JSON.stringify({
					version: 1,
					skills: {
						neon: {
							source: "neondatabase/agent-skills",
							skillPath: "skills/neon/SKILL.md",
							computedHash: CONTENT,
							ref: "v1",
						},
					},
				}),
			);
			expect(readLockedSkills(path, "project")).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reports a malformed lock without quoting its contents", () => {
		const dir = mkdtempSync(join(tmpdir(), "neon-skills-lock-"));
		try {
			const path = join(dir, "skills-lock.json");
			writeFileSync(path, "\u001b]52;c;eA==\u0007");
			expect(() => readLockedSkills(path, "project")).toThrow(
				new Error(`${path} is not valid JSON.`),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("refuses a lock that is not a regular file, and follows a link to one", () => {
		const dir = mkdtempSync(join(tmpdir(), "neon-skills-lock-"));
		try {
			const zero = join(dir, "zero.json");
			symlinkSync("/dev/zero", zero);
			expect(() => readLockedSkills(zero, "project")).toThrow(
				new Error(`${zero} is not a regular file.`),
			);

			const fifo = join(dir, "fifo.json");
			execFileSync("mkfifo", [fifo]);
			expect(() => readLockedSkills(fifo, "project")).toThrow(
				new Error(`${fifo} is not a regular file.`),
			);

			const real = join(dir, "real.json");
			writeFileSync(
				real,
				JSON.stringify({
					version: 1,
					skills: {
						neon: {
							source: "neondatabase/agent-skills",
							skillPath: "skills/neon/SKILL.md",
							computedHash: CONTENT,
						},
					},
				}),
			);
			const link = join(dir, "skills-lock.json");
			symlinkSync(real, link);
			expect(readLockedSkills(link, "project")).toEqual([
				neon("project", CONTENT),
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("skillStatus", () => {
	test("compares a tree hash with the tree SHA", () => {
		expect(
			skillStatus(neon("global", TREE), {
				tree: TREE,
				content: NEW_CONTENT,
			}),
		).toBe("up to date");
		expect(skillStatus(neon("global", TREE), { tree: NEW_TREE })).toBe(
			"outdated",
		);
	});

	test("compares a content hash with the content hash", () => {
		expect(
			skillStatus(neon("project", CONTENT), {
				tree: TREE,
				content: CONTENT,
			}),
		).toBe("up to date");
		expect(
			skillStatus(neon("global", CONTENT, "content"), {
				tree: TREE,
				content: NEW_CONTENT,
			}),
		).toBe("outdated");
	});

	test("has no answer before the needed hash is fetched", () => {
		expect(
			skillStatus(neon("project", CONTENT), undefined),
		).toBeUndefined();
		expect(
			skillStatus(neon("project", CONTENT), { tree: TREE }),
		).toBeUndefined();
		expect(skillStatus(neon("global", TREE), { missing: true })).toBe(
			"not found upstream",
		);
	});
});

describe("planSkillsCheck", () => {
	const now = Date.UTC(2026, 9, 26);
	const checked = (folders: Record<string, RemoteFolder>) => ({
		checkedAt: now - 1000,
		folders,
	});

	test("warns from a fresh cache without checking again", () => {
		const skill = neon("project", CONTENT);
		expect(
			planSkillsCheck({
				skills: [skill],
				cache: checked({
					[KEY]: { tree: NEW_TREE, content: NEW_CONTENT },
				}),
				lockModifiedAt: now - 5000,
				now,
			}),
		).toEqual({ outdated: [skill], toCheck: [], refresh: false });
	});

	test("checks a project skill whose folder only has a tree SHA cached", () => {
		const skill = neon("project", CONTENT);
		expect(
			planSkillsCheck({
				skills: [skill],
				cache: checked({ [KEY]: { tree: TREE } }),
				lockModifiedAt: now - 5000,
				now,
			}),
		).toEqual({ outdated: [], toCheck: [skill], refresh: true });
	});

	test("waits for a pending check instead of starting another", () => {
		expect(
			planSkillsCheck({
				skills: [neon("project", CONTENT)],
				cache: checked({ [KEY]: { tree: TREE, pending: true } }),
				lockModifiedAt: now - 5000,
				now,
			}),
		).toEqual({ outdated: [], toCheck: [], refresh: false });
	});

	test("holds back the warning after the lock changes, and checks again", () => {
		const skill = neon("project", NEW_CONTENT);
		expect(
			planSkillsCheck({
				skills: [skill],
				cache: checked({ [KEY]: { tree: TREE, content: CONTENT } }),
				lockModifiedAt: now - 500,
				now,
			}),
		).toEqual({ outdated: [], toCheck: [skill], refresh: true });
	});

	test("keeps holding back after another directory starts a check", () => {
		const updated = neon("project", NEW_CONTENT);
		const cache = {
			checkedAt: now - 3000,
			attemptedAt: now - 1000,
			folders: {
				[KEY]: { tree: TREE, content: CONTENT },
				"neondatabase/agent-skills:skills/neon-auth": {
					pending: true as const,
				},
			},
		};
		expect(
			planSkillsCheck({
				skills: [updated],
				cache,
				lockModifiedAt: now - 2000,
				now,
			}),
		).toEqual({ outdated: [], toCheck: [updated], refresh: true });
	});

	test("waits a day after a check that never finished", () => {
		expect(
			planSkillsCheck({
				skills: [neon("global", TREE)],
				cache: {
					checkedAt: now - 3 * 24 * 60 * 60 * 1000,
					attemptedAt: now - 1000,
					folders: { [KEY]: { tree: TREE } },
				},
				lockModifiedAt: 0,
				now,
			}).refresh,
		).toBe(false);
	});

	test("refreshes a day-old cache", () => {
		expect(
			planSkillsCheck({
				skills: [neon("global", TREE)],
				cache: {
					checkedAt: now - 24 * 60 * 60 * 1000,
					folders: { [KEY]: { tree: TREE } },
				},
				lockModifiedAt: 0,
				now,
			}).refresh,
		).toBe(true);
	});
});

describe("skillsTelemetry", () => {
	const checkedAt = Date.UTC(2026, 9, 26);
	const none = { skills: [], modifiedAt: 0 };
	const installed = (skill: LockedSkill, modifiedAt = checkedAt - 1000) => ({
		skills: [skill],
		modifiedAt,
	});
	const cache = (folders: Record<string, RemoteFolder>, at = checkedAt) => ({
		checkedAt: at,
		folders,
	});

	test("says explicitly when a scope has no Neon skills", () => {
		expect(
			skillsTelemetry({ global: none, project: none }, undefined),
		).toEqual({
			checkedAt: null,
			global: { installed: false },
			project: { installed: false },
		});
	});

	test("reports each skill's lock hash and whether it is outdated", () => {
		expect(
			skillsTelemetry(
				{
					global: installed(neon("global", TREE)),
					project: installed(neon("project", CONTENT)),
				},
				cache({ [KEY]: { tree: TREE, content: NEW_CONTENT } }),
			),
		).toEqual({
			checkedAt,
			global: {
				installed: true,
				skills: { neon: { hash: TREE, outdated: false } },
			},
			project: {
				installed: true,
				skills: { neon: { hash: CONTENT, outdated: true } },
			},
		});
	});

	test("reports a pinned skill as installed with outdated unknown", () => {
		expect(
			skillsTelemetry(
				{
					global: none,
					project: installed({
						...neon("project", CONTENT),
						pinned: true,
					}),
				},
				cache({ [KEY]: { tree: TREE, content: NEW_CONTENT } }),
			).project,
		).toEqual({
			installed: true,
			skills: { neon: { hash: CONTENT, outdated: null } },
		});
	});

	test("leaves outdated unknown when the cache cannot answer", () => {
		const unknown = (scope: SkillsTelemetryScope) =>
			scope.installed ? scope.skills.neon?.outdated : "not installed";
		const project = (
			remote: RemoteFolder,
			options: { modifiedAt?: number; at?: number } = {},
		) =>
			skillsTelemetry(
				{
					global: none,
					project: installed(
						neon("project", CONTENT),
						options.modifiedAt,
					),
				},
				cache({ [KEY]: remote }, options.at),
			).project;

		expect(unknown(project({ tree: TREE }))).toBeNull();
		expect(
			unknown(project({ tree: TREE, content: CONTENT, pending: true })),
		).toBeNull();
		expect(
			unknown(
				project(
					{ tree: TREE, content: CONTENT },
					{ modifiedAt: checkedAt + 1 },
				),
			),
		).toBeNull();
		expect(
			unknown(project({ tree: TREE, content: CONTENT }, { at: 0 })),
		).toBeNull();
		expect(
			skillsTelemetry(
				{ global: none, project: installed(neon("project", CONTENT)) },
				undefined,
			),
		).toMatchObject({
			checkedAt: null,
			project: { skills: { neon: { hash: CONTENT, outdated: null } } },
		});
	});
});

describe("skillContentHash", () => {
	const bytes = (text: string) => new TextEncoder().encode(text);

	test("does not depend on file order", () => {
		const a = { path: "SKILL.md", bytes: bytes("a") };
		const b = { path: "references/b.md", bytes: bytes("b") };
		expect(skillContentHash([a, b])).toBe(skillContentHash([b, a]));
	});

	test("covers paths as well as contents", () => {
		expect(
			skillContentHash([{ path: "a.md", bytes: bytes("x") }]),
		).not.toBe(skillContentHash([{ path: "b.md", bytes: bytes("x") }]));
	});
});

describe("parseSkillsCheckCache", () => {
	test("drops malformed folders and keeps the rest", () => {
		expect(
			parseSkillsCheckCache(
				JSON.stringify({
					checkedAt: 1,
					folders: {
						a: { tree: "t" },
						b: { tree: 1 },
						c: { pending: true },
						d: { pending: "yes" },
					},
				}),
			),
		).toEqual({
			checkedAt: 1,
			folders: { a: { tree: "t" }, c: { pending: true } },
		});
	});

	test("rejects a cache without a check time", () => {
		expect(parseSkillsCheckCache('{"folders":{}}')).toBeUndefined();
	});
});

describe("formatSkillsNotice", () => {
	test("groups by scope and names the update command for each", () => {
		expect(
			formatSkillsNotice([
				neon("global", TREE),
				{ ...neon("global", TREE), skill: "neon-functions" },
				{ ...neon("project", CONTENT), skill: "neon-postgres" },
			]),
		).toBe(
			[
				"Neon agent skills have updates:",
				"  user-level: neon, neon-functions",
				"  this directory: neon-postgres",
				"Update them:",
				"  neon skills update --global -y",
				"  neon skills update -y",
			].join("\n"),
		);
	});

	test("says nothing when every skill is current", () => {
		expect(formatSkillsNotice([])).toBeUndefined();
	});
});
