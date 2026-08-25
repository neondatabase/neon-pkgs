import { describe, expect, test } from "vitest";

import { helpCsv } from "./help_text.js";

describe("helpCsv", () => {
	test("keeps a short list on one line", () => {
		expect(helpCsv("Also with --global", ["vscode", "codex"])).toBe(
			"Also with --global: vscode, codex",
		);
	});

	test("wraps before a token that would exceed the width", () => {
		expect(helpCsv("Supported agents", ["aaaa", "bbbb", "cccc"], 24)).toBe(
			"Supported agents: aaaa\n  bbbb, cccc",
		);
	});

	test("refuses an empty list", () => {
		expect(() => helpCsv("Supported agents", [])).toThrow(
			/Supported agents needs at least one value/,
		);
	});
});
