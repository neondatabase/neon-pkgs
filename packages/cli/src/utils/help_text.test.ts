import { describe, expect, test } from "vitest";

import { helpCsv, helpEpilogue } from "./help_text.js";

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

describe("helpEpilogue", () => {
	test("starts with a blank line and drops empty blocks", () => {
		expect(helpEpilogue("Installs https://mcp.neon.tech/mcp", "")).toBe(
			"\nInstalls https://mcp.neon.tech/mcp",
		);
	});
});
