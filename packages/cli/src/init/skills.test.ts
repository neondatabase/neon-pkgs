import { describe, expect, test } from "vitest";
import { DOC_REFERENCE_URLS } from "./skills.js";

describe("DOC_REFERENCE_URLS", () => {
	test("contains gettingStarted URL", () => {
		expect(DOC_REFERENCE_URLS.gettingStarted).toBe(
			"https://neon.com/docs/get-started/backend-overview.md",
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
			expect(DOC_REFERENCE_URLS).toHaveProperty(key);
			expect(DOC_REFERENCE_URLS[key]).toMatch(/^https:\/\/neon\.com\//);
		}
	});

	test("all URLs end with .md", () => {
		for (const url of Object.values(DOC_REFERENCE_URLS)) {
			expect(url).toMatch(/\.md$/);
		}
	});
});
