import { describe, expect, test } from "vitest";

import {
	agentChoicesFrom,
	canPickAgentsInteractively,
	pickAgentsInteractively,
	resolveAgentSelection,
} from "./agent_picker.js";

describe("agentChoicesFrom", () => {
	test("puts detected agents first and marks them", () => {
		expect(
			agentChoicesFrom(["cursor", "claude-code", "vscode"], ["vscode"]),
		).toEqual([
			{ id: "vscode", title: "VS Code", description: "detected" },
			{ id: "cursor", title: "Cursor" },
			{ id: "claude-code", title: "Claude Code" },
		]);
	});
});

describe("resolveAgentSelection", () => {
	const choices = agentChoicesFrom(["cursor", "claude-code"], ["cursor"]);

	test("uses specified values and skips the picker", async () => {
		const picked: string[] = [];
		const result = await resolveAgentSelection({
			specified: ["claude", "cursor"],
			choices,
			detected: ["cursor"],
			message: "pick",
			nonInteractiveMessage: "pass -y",
			pick: async () => {
				picked.push("called");
				return ["cursor"];
			},
		});
		expect(result).toEqual(["claude-code", "cursor"]);
		expect(picked).toEqual([]);
	});

	test("dedupes aliases in specified agents", async () => {
		const result = await resolveAgentSelection({
			specified: ["claude", "claude-code"],
			choices,
			detected: [],
			message: "pick",
			nonInteractiveMessage: "pass -y",
		});
		expect(result).toEqual(["claude-code"]);
	});

	test("throws on an unknown specified agent without calling the picker", async () => {
		await expect(
			resolveAgentSelection({
				specified: ["not-an-agent"],
				choices,
				detected: ["cursor"],
				message: "pick",
				nonInteractiveMessage: "pass -y",
				pick: async () => ["cursor"],
			}),
		).rejects.toThrow(/Unknown agent: "not-an-agent"/);
	});

	test("uses resolveSpecified for specified values", async () => {
		const result = await resolveAgentSelection({
			specified: ["cursor-alias"],
			choices,
			detected: [],
			message: "pick",
			nonInteractiveMessage: "pass -y",
			resolveSpecified: (raw) => {
				if (raw !== "cursor-alias") {
					throw new Error(`unexpected: ${raw}`);
				}
				return "cursor";
			},
		});
		expect(result).toEqual(["cursor"]);
	});

	test("uses an injected picker when nothing is specified", async () => {
		const result = await resolveAgentSelection({
			specified: [],
			choices,
			detected: ["cursor"],
			message: "pick",
			nonInteractiveMessage: "pass -y",
			pick: async (options) => {
				expect(options.selected).toEqual(["cursor"]);
				expect(options.choices).toEqual(choices);
				return ["claude-code"];
			},
		});
		expect(result).toEqual(["claude-code"]);
	});

	test("rejects an empty picker result", async () => {
		await expect(
			resolveAgentSelection({
				specified: [],
				choices,
				detected: ["cursor"],
				message: "pick",
				nonInteractiveMessage: "pass -y",
				pick: async () => [],
			}),
		).rejects.toThrow(/No agents selected/);
	});

	test("falls back to detected agents when not interactive", async () => {
		const result = await resolveAgentSelection({
			specified: [],
			choices,
			detected: ["cursor", "claude-code"],
			message: "pick",
			nonInteractiveMessage: "pass -y",
		});
		expect(result).toEqual(["cursor", "claude-code"]);
	});

	test("interactive: false uses detected agents and skips an omitted picker", async () => {
		const result = await resolveAgentSelection({
			specified: [],
			choices,
			detected: ["cursor"],
			message: "pick",
			nonInteractiveMessage: "pass -y",
			interactive: false,
		});
		expect(result).toEqual(["cursor"]);
	});

	test("throws the caller message when nothing is detected and there is no TTY", async () => {
		await expect(
			resolveAgentSelection({
				specified: [],
				choices,
				detected: [],
				message: "pick",
				nonInteractiveMessage: "pass -y",
			}),
		).rejects.toThrow("pass -y");
	});
});

describe("pickAgentsInteractively", () => {
	const originalIsTTY = process.stdout.isTTY;

	test("throws when there is no interactive terminal", async () => {
		process.stdout.isTTY = false;
		try {
			await expect(
				pickAgentsInteractively({
					message: "pick",
					choices: [{ id: "cursor", title: "Cursor" }],
				}),
			).rejects.toThrow(/Pass -y/);
		} finally {
			process.stdout.isTTY = originalIsTTY;
		}
	});
});

describe("canPickAgentsInteractively", () => {
	test("is false in CI", () => {
		expect(canPickAgentsInteractively()).toBe(false);
	});
});
