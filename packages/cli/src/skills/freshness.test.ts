import { describe, expect, test } from "vitest";
import {
	formatSkillsNotice,
	type LockedSkill,
	parseSkillsCheckCache,
	parseSkillsLock,
	skillContentHash,
	skillStatus,
} from "./freshness.js";

const neon = (scope: LockedSkill["scope"], hash: string): LockedSkill => ({
	scope,
	skill: "neon",
	source: "neondatabase/agent-skills",
	folder: "skills/neon",
	hash,
});

describe("parseSkillsLock", () => {
	const lock = JSON.stringify({
		version: 3,
		skills: {
			neon: {
				source: "neondatabase/agent-skills",
				skillPath: "skills/neon/SKILL.md",
				skillFolderHash: "tree-sha",
				computedHash: "content-sha",
			},
			pinned: {
				source: "neondatabase/agent-skills",
				skillPath: "skills/neon-auth/SKILL.md",
				ref: "v1",
				skillFolderHash: "tree-sha",
				computedHash: "content-sha",
			},
			other: {
				source: "vercel-labs/agent-skills",
				skillPath: "skills/x/SKILL.md",
				skillFolderHash: "tree-sha",
				computedHash: "content-sha",
			},
		},
	});

	test("reads the hash field the scope's lock writes", () => {
		expect(parseSkillsLock(lock, "global")).toEqual([
			neon("global", "tree-sha"),
		]);
		expect(parseSkillsLock(lock, "project")).toEqual([
			neon("project", "content-sha"),
		]);
	});

	test("throws on a lock that is not JSON", () => {
		expect(() => parseSkillsLock("{", "project")).toThrow();
	});
});

describe("skillStatus", () => {
	test("compares the global lock with the tree SHA", () => {
		expect(
			skillStatus(neon("global", "a"), { tree: "a", content: "b" }),
		).toBe("up to date");
		expect(skillStatus(neon("global", "a"), { tree: "c" })).toBe(
			"outdated",
		);
	});

	test("compares a project lock with the content hash", () => {
		expect(
			skillStatus(neon("project", "b"), { tree: "a", content: "b" }),
		).toBe("up to date");
		expect(
			skillStatus(neon("project", "b"), { tree: "a", content: "c" }),
		).toBe("outdated");
	});

	test("has no answer before the folder is fetched", () => {
		expect(skillStatus(neon("project", "b"), undefined)).toBeUndefined();
		expect(skillStatus(neon("project", "b"), {})).toBeUndefined();
		expect(
			skillStatus(neon("project", "b"), { tree: "a" }),
		).toBeUndefined();
		expect(skillStatus(neon("global", "a"), { missing: true })).toBe(
			"not found upstream",
		);
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
					folders: { a: { tree: "t" }, b: { tree: 1 }, c: {} },
				}),
			),
		).toEqual({ checkedAt: 1, folders: { a: { tree: "t" }, c: {} } });
	});

	test("rejects a cache without a check time", () => {
		expect(parseSkillsCheckCache('{"folders":{}}')).toBeUndefined();
	});
});

describe("formatSkillsNotice", () => {
	test("groups by scope and names the update command for each", () => {
		expect(
			formatSkillsNotice([
				neon("global", "a"),
				{ ...neon("global", "a"), skill: "neon-functions" },
				{ ...neon("project", "b"), skill: "neon-postgres" },
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
