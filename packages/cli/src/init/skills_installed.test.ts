import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { skillsInstalledForAgent } from "./skills.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("skillsInstalledForAgent", () => {
	test("treats .agents/skills as installed for agents without a dedicated dir", () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-skills-"));
		dirs.push(cwd);
		mkdirSync(join(cwd, ".agents", "skills", "neon-postgres"), {
			recursive: true,
		});
		writeFileSync(
			join(cwd, ".agents", "skills", "neon-postgres", "SKILL.md"),
			"",
		);

		expect(skillsInstalledForAgent("windsurf", cwd)).toBe(true);
		expect(skillsInstalledForAgent("zed", cwd)).toBe(true);
	});
});
