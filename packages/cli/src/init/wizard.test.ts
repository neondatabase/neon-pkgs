import { afterEach, describe, expect, test, vi } from "vitest";

const promptsMock = vi.hoisted(() => vi.fn());
const canPickMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("prompts", () => ({
	default: promptsMock,
}));

vi.mock("../utils/agent_picker.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../utils/agent_picker.js")>();
	return {
		...original,
		canPickAgentsInteractively: canPickMock,
	};
});

import {
	pickAgentSetupInteractively,
	pickInitConfigInteractively,
	pickInitTemplateInteractively,
} from "./wizard.js";

describe("init pickers", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		promptsMock.mockReset();
		canPickMock.mockReset();
		canPickMock.mockReturnValue(false);
	});

	test("agent setup refuses when there is no TTY", async () => {
		canPickMock.mockReturnValue(false);
		await expect(pickAgentSetupInteractively()).rejects.toThrow(
			/No interactive terminal/,
		);
	});

	test("template picker refuses when there is no TTY", async () => {
		canPickMock.mockReturnValue(false);
		await expect(pickInitTemplateInteractively([])).rejects.toThrow(
			/No interactive terminal/,
		);
	});

	test("config picker refuses when there is no TTY", async () => {
		canPickMock.mockReturnValue(false);
		await expect(pickInitConfigInteractively()).rejects.toThrow(
			/No interactive terminal/,
		);
	});

	test("agent setup copy names plugin, skills, and skip", async () => {
		canPickMock.mockReturnValue(true);
		promptsMock.mockResolvedValue({ setup: "plugin" });
		await pickAgentSetupInteractively();
		const question = promptsMock.mock.calls[0]?.[0] as {
			message: string;
			choices: Array<{ title: string; value: string }>;
		};
		expect(question.message).toBe(
			"How would you like to set up your coding agents?",
		);
		expect(question.choices.map((choice) => choice.value)).toEqual([
			"plugin",
			"skills-mcp",
			"skip",
		]);
		expect(question.choices[0]?.title).toMatch(/recommended/i);
		expect(question.choices[2]?.title).toBe("Skip agent setup");
	});

	test("template picker ends with skip the template", async () => {
		canPickMock.mockReturnValue(true);
		promptsMock.mockResolvedValue({ id: "skip" });
		const picked = await pickInitTemplateInteractively([
			{
				id: "hono",
				title: "Hono API",
				description: "A Hono API",
				requires: ["database"],
				source: {
					owner: "neondatabase",
					repo: "examples",
					ref: "main",
					subdir: "with-hono",
				},
			},
		]);
		expect(picked).toEqual({ kind: "skip" });
		const question = promptsMock.mock.calls[0]?.[0] as {
			message: string;
			choices: Array<{
				title: string;
				value: string;
				description: string;
			}>;
		};
		expect(question.message).toBe(
			"How would you like to set up this directory?",
		);
		expect(question.choices.at(-1)?.value).toBe("skip");
		expect(question.choices.at(-1)?.title).toBe("Skip the template");
		expect(question.choices[0]?.title).toMatch(/recommended/i);
	});

	test("config confirm defaults to yes", async () => {
		canPickMock.mockReturnValue(true);
		promptsMock.mockResolvedValue({ value: false });
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const accepted = await pickInitConfigInteractively();
		expect(accepted).toBe(false);
		const question = promptsMock.mock.calls[0]?.[0] as {
			message: string;
			initial: boolean;
		};
		expect(question.message).toBe(
			"Create neon.ts to manage this project's Neon setup as code?",
		);
		expect(question.initial).toBe(true);
		expect(
			stdout.mock.calls.map((call) => String(call[0])).join(""),
		).toMatch(/neon config apply/);
	});
});
