import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
	detectSkillsAgents,
	mappedSkillsAgentNames,
	skillsInstallableAgents,
} from "./targets.js";

describe("skillsInstallableAgents", () => {
	test("is the MCP roster minus agents with no skills mapping", () => {
		const ids = skillsInstallableAgents();
		expect(ids).toContain("cursor");
		expect(ids).toContain("claude-desktop");
		expect(ids).not.toContain("mcporter");
		expect(ids).not.toContain("eve");
		expect(ids).not.toContain("cursor-cli");
	});
});

describe("mappedSkillsAgentNames", () => {
	test("dedupes Claude Desktop and Claude Code onto claude-code", () => {
		expect(
			mappedSkillsAgentNames(["claude-desktop", "claude-code", "cursor"]),
		).toEqual(["claude-code", "cursor"]);
	});

	test("throws when every selected agent lacks a mapping", () => {
		expect(() => mappedSkillsAgentNames(["mcporter"])).toThrow(
			/None of the selected agents can install skills/,
		);
	});
});

describe("detectSkillsAgents", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("project scope detects from the project folder", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-skills-detect-"));
		dirs.push(cwd);
		mkdirSync(join(cwd, ".cursor"));
		expect(await detectSkillsAgents({ scope: "project", cwd })).toContain(
			"cursor",
		);
	});

	test("project scope ignores a folder with no agent markers", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-skills-detect-empty-"));
		dirs.push(cwd);
		expect(await detectSkillsAgents({ scope: "project", cwd })).toEqual([]);
	});
});
