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

import { InitCancelled } from "./cancelled.js";
import {
	pickAgentSetupInteractively,
	pickInitAgentsInteractively,
	pickInitConfigInteractively,
	pickInitLinkInteractively,
	pickInitModeInteractively,
	pickInitProjectSetupInteractively,
	pickInitServicesInteractively,
} from "./wizard.js";

const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;

describe("init pickers", () => {
	afterEach(() => {
		process.stdin.isTTY = originalStdinIsTTY;
		process.stdout.isTTY = originalStdoutIsTTY;
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

	test("config picker refuses when there is no TTY", async () => {
		canPickMock.mockReturnValue(false);
		await expect(pickInitConfigInteractively()).rejects.toThrow(
			/No interactive terminal/,
		);
	});

	test("link picker refuses when there is no TTY", async () => {
		canPickMock.mockReturnValue(false);
		await expect(pickInitLinkInteractively()).rejects.toThrow(
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
			"How should Neon be added to your coding agents?",
		);
		expect(question.choices.map((choice) => choice.value)).toEqual([
			"plugin",
			"skills-mcp",
			"skip",
		]);
		expect(question.choices[0]?.title).toBe("Neon plugin");
		expect(question.choices[2]?.title).toBe("Skip agent setup");
	});

	test.each([
		true,
		false,
		undefined,
	])("empty agent confirmation: %s", async (skip) => {
		canPickMock.mockReturnValue(true);
		vi.stubEnv("CI", "");
		process.stdin.isTTY = process.stdout.isTTY = true;
		promptsMock
			.mockResolvedValueOnce({ agents: [] })
			.mockResolvedValueOnce({ skip })
			.mockResolvedValueOnce({ agents: ["cursor"] });
		const result = pickInitAgentsInteractively({
			available: ["cursor"],
			detected: [],
			setup: "plugin",
		});
		if (skip === undefined) {
			await expect(result).rejects.toBeInstanceOf(InitCancelled);
		} else {
			await expect(result).resolves.toEqual(
				skip ? undefined : ["cursor"],
			);
		}
		expect(promptsMock).toHaveBeenCalledTimes(skip === false ? 3 : 2);
	});

	test("mode picker lists Recommended then Custom", async () => {
		canPickMock.mockReturnValue(true);
		promptsMock.mockResolvedValue({ mode: "recommended" });
		await pickInitModeInteractively();
		const question = promptsMock.mock.calls[0]?.[0] as {
			message: string;
			choices: Array<{ title: string; value: string }>;
		};
		expect(question.message).toBe("How would you like to set up Neon?");
		expect(question.choices.map((choice) => choice.value)).toEqual([
			"recommended",
			"custom",
		]);
		expect(question.choices[0]?.title).toBe("Recommended setup");
		expect(question.choices[1]?.title).toBe("Custom setup");
	});

	test("project setup lists sign-in then claimable", async () => {
		canPickMock.mockReturnValue(true);
		promptsMock.mockResolvedValue({ setup: "link" });
		await pickInitProjectSetupInteractively();
		const question = promptsMock.mock.calls[0]?.[0] as {
			message: string;
			choices: Array<{
				title: string;
				value: string;
				description: string;
			}>;
		};
		expect(question.message).toBe(
			"How would you like to get a Neon project?",
		);
		expect(question.choices.map((choice) => choice.value)).toEqual([
			"link",
			"claimable",
		]);
		expect(question.choices[0]?.title).toBe("Sign in to Neon");
		expect(question.choices[1]?.description).toMatch(/72 hours/);
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
		expect(question.message).toBe("Create neon.ts in this directory?");
		expect(question.initial).toBe(true);
		expect(
			stdout.mock.calls.map((call) => String(call[0])).join(""),
		).toMatch(/Declare Neon services/);
	});

	test("link confirm describes the action without another command", async () => {
		canPickMock.mockReturnValue(true);
		promptsMock.mockResolvedValue({ value: true });
		const accepted = await pickInitLinkInteractively();
		expect(accepted).toBe(true);
		const question = promptsMock.mock.calls[0]?.[0] as {
			message: string;
			initial: boolean;
		};
		expect(question.message).toBe(
			"Link this project to a Neon project now?",
		);
		expect(question.message).not.toMatch(/runs neon link/i);
		expect(question.initial).toBe(true);
	});

	test("services picker locks Postgres as always included", async () => {
		canPickMock.mockReturnValue(true);
		promptsMock.mockResolvedValue({ services: ["postgres", "auth"] });
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const picked = await pickInitServicesInteractively();
		expect(picked).toEqual(["auth"]);
		const question = promptsMock.mock.calls[0]?.[0] as {
			message: string;
			cursor: number;
			onRender: (this: unknown) => void;
			choices: Array<{
				title: string;
				value: string;
				selected?: boolean;
			}>;
		};
		expect(question.message).toBe(
			"Which services should neon.ts declare? (space to toggle, enter to confirm)",
		);
		expect(question.cursor).toBe(1);
		expect(question.choices[0]?.value).toBe("postgres");
		expect(question.choices[0]?.title).toBe("Postgres (always included)");
		expect(question.choices[0]?.selected).toBe(true);
		expect(
			stdout.mock.calls.map((call) => String(call[0])).join(""),
		).toMatch(/optional services/);
		const prompt = {
			value: [
				{ value: "postgres", selected: false },
				{ value: "auth", selected: true },
			],
		};
		question.onRender.call(prompt);
		expect(prompt.value[0]?.selected).toBe(true);
	});

	test("services picker with only Postgres selected writes the default neon.ts", async () => {
		canPickMock.mockReturnValue(true);
		promptsMock.mockResolvedValue({ services: ["postgres"] });
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await expect(pickInitServicesInteractively()).resolves.toEqual([]);
	});
});
