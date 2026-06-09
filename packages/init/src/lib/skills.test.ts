import { describe, expect, test } from "vitest";
import { SKILL_REFERENCE_URLS } from "./skills.js";

describe("SKILL_REFERENCE_URLS", () => {
	test("contains gettingStarted URL", () => {
		expect(SKILL_REFERENCE_URLS.gettingStarted).toBe(
			"https://neon.com/docs/ai/skills/neon-postgres/references/getting-started.md",
		);
	});

	test("contains all expected reference keys", () => {
		const expectedKeys = [
			"gettingStarted",
			"connectionMethods",
			"neonAuth",
			"serverlessDriver",
			"neonCli",
			"devtools",
			"branching",
			"neonJs",
		];
		for (const key of expectedKeys) {
			expect(SKILL_REFERENCE_URLS).toHaveProperty(key);
			expect(SKILL_REFERENCE_URLS[key]).toMatch(/^https:\/\/neon\.com\//);
		}
	});

	test("all URLs end with .md", () => {
		for (const url of Object.values(SKILL_REFERENCE_URLS)) {
			expect(url).toMatch(/\.md$/);
		}
	});
});
