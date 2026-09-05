import { describe, expect, test } from "vitest";

import { helpCsv, helpEpilogue, wrapHelpText } from "./help_text.js";

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

	test("wraps before the first item when the label plus item exceeds width", () => {
		expect(
			helpCsv(
				"Supported agents at project scope",
				["claude-code", "cursor"],
				39,
			),
		).toBe("Supported agents at project scope:\n    claude-code, cursor");
	});

	test("omits an empty list", () => {
		expect(helpCsv("Supported agents", [])).toBe("");
	});
});

describe("wrapHelpText", () => {
	test("keeps a short string on one line", () => {
		expect(wrapHelpText("authenticated passthrough", 80)).toBe(
			"authenticated passthrough",
		);
	});

	test("wraps on word boundaries", () => {
		expect(wrapHelpText("authenticated passthrough", 14)).toBe(
			"authenticated\npassthrough",
		);
	});

	test("does not split a word longer than the width", () => {
		expect(wrapHelpText("passthrough", 4)).toBe("passthrough");
	});
});

describe("helpEpilogue", () => {
	test("starts with a blank line and drops empty blocks", () => {
		expect(helpEpilogue("Installs https://mcp.neon.tech/mcp", "")).toBe(
			"\nInstalls https://mcp.neon.tech/mcp",
		);
	});
});
