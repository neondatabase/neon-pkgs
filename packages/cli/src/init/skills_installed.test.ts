import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { missingSkillsForAgent, skillsInstalledForAgent } from "./skills.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function writeSkills(cwd: string, root: string, names: string[]) {
	for (const name of names) {
		mkdirSync(join(cwd, root, name), { recursive: true });
		writeFileSync(join(cwd, root, name, "SKILL.md"), "");
	}
}

describe("skillsInstalledForAgent", () => {
	test("treats .agents/skills as installed for agents without a dedicated dir", () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-skills-"));
		dirs.push(cwd);
		writeSkills(cwd, ".agents/skills", ["neon", "neon-postgres"]);

		expect(skillsInstalledForAgent("windsurf", cwd)).toBe(true);
		expect(skillsInstalledForAgent("zed", cwd)).toBe(true);
	});

	test("treats .grok/skills as installed for grok-build", () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-skills-"));
		dirs.push(cwd);
		writeSkills(cwd, ".grok/skills", ["neon", "neon-postgres"]);

		expect(skillsInstalledForAgent("grok-build", cwd)).toBe(true);
	});

	test("does not treat preview as installed when only base skills exist", () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-skills-"));
		dirs.push(cwd);
		writeSkills(cwd, ".cursor/skills", ["neon", "neon-postgres"]);

		expect(skillsInstalledForAgent("cursor", cwd, true)).toBe(false);
		expect(skillsInstalledForAgent("cursor", cwd)).toBe(true);
	});

	test("does not treat a single base skill as installed", () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-skills-"));
		dirs.push(cwd);
		writeSkills(cwd, ".cursor/skills", ["neon-postgres"]);

		expect(skillsInstalledForAgent("cursor", cwd)).toBe(false);
	});
});

describe("missingSkillsForAgent", () => {
	test("does not treat another agent's files as present", () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-skills-"));
		dirs.push(cwd);
		writeSkills(cwd, ".cursor/skills", ["neon", "neon-postgres"]);

		expect(
			missingSkillsForAgent("grok-build", { cwd, scope: "project" }),
		).toEqual(["neon", "neon-postgres"]);
	});

	test("lists preview skills that are not on disk for that agent", () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-skills-"));
		dirs.push(cwd);
		writeSkills(cwd, ".cursor/skills", ["neon", "neon-postgres"]);

		expect(
			missingSkillsForAgent("cursor", {
				cwd,
				scope: "project",
				preview: true,
			}),
		).toEqual(["neon-object-storage", "neon-functions", "neon-ai-gateway"]);
	});
});
