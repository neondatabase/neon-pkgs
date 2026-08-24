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

	test("uses --agent values and skips the picker", async () => {
		const picked: string[] = [];
		const result = await resolveAgentSelection({
			specified: ["claude", "cursor"],
			choices,
			detected: ["cursor"],
			message: "pick",
			nonInteractiveMessage: "pass --agent",
			pick: async () => {
				picked.push("called");
				return ["cursor"];
			},
		});
		expect(result).toEqual(["claude-code", "cursor"]);
		expect(picked).toEqual([]);
	});

	test("dedupes aliases in --agent", async () => {
		const result = await resolveAgentSelection({
			specified: ["claude", "claude-code"],
			choices,
			detected: [],
			message: "pick",
			nonInteractiveMessage: "pass --agent",
		});
		expect(result).toEqual(["claude-code"]);
	});

	test("throws on an unknown --agent without calling the picker", async () => {
		await expect(
			resolveAgentSelection({
				specified: ["not-an-agent"],
				choices,
				detected: ["cursor"],
				message: "pick",
				nonInteractiveMessage: "pass --agent",
				pick: async () => ["cursor"],
			}),
		).rejects.toThrow(/Unknown agent: "not-an-agent"/);
	});

	test("uses an injected picker when nothing is specified", async () => {
		const result = await resolveAgentSelection({
			specified: [],
			choices,
			detected: ["cursor"],
			message: "pick",
			nonInteractiveMessage: "pass --agent",
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
				nonInteractiveMessage: "pass --agent",
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
			nonInteractiveMessage: "pass --agent",
		});
		expect(result).toEqual(["cursor", "claude-code"]);
	});

	test("throws the caller message when nothing is detected and there is no TTY", async () => {
		await expect(
			resolveAgentSelection({
				specified: [],
				choices,
				detected: [],
				message: "pick",
				nonInteractiveMessage: "pass --agent cursor",
			}),
		).rejects.toThrow("pass --agent cursor");
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
			).rejects.toThrow(/Pass --agent/);
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
