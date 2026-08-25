import { describe, expect, test } from "vitest";

import { helpCsv } from "./help_text.js";

describe("helpCsv", () => {
	test("keeps a short list on one line", () => {
		expect(helpCsv("Also with --global", ["vscode", "codex"])).toBe(
			"Also with --global: vscode, codex",
		);
	});

	test("wraps with a trailing comma and a deeper indent", () => {
		expect(helpCsv("Supported agents", ["aaaa", "bbbb", "cccc"], 24)).toBe(
			"Supported agents: aaaa,\n    bbbb, cccc",
		);
	});

	test("omits an empty list", () => {
		expect(helpCsv("Supported agents", [])).toBe("");
	});
});
