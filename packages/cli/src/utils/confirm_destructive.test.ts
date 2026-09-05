import { describe, expect, test } from "vitest";

import {
	confirmDestructive,
	isMachineOutput,
	namedResource,
} from "./confirm_destructive.js";

describe("namedResource", () => {
	test("includes the name when it is present", () => {
		expect(namedResource("proj-1", "demo")).toBe("proj-1 (demo)");
	});

	test("omits empty and missing names", () => {
		expect(namedResource("proj-1", undefined)).toBe("proj-1");
		expect(namedResource("proj-1", "")).toBe("proj-1");
	});
});

describe("isMachineOutput", () => {
	test("json and yaml require --yes even on a TTY", () => {
		expect(isMachineOutput("json")).toBe(true);
		expect(isMachineOutput("yaml")).toBe(true);
		expect(isMachineOutput("table")).toBe(false);
	});
});

describe("confirmDestructive", () => {
	test("returns immediately when --yes is set", async () => {
		let prompted = false;
		await confirmDestructive(
			{ yes: true, noun: "project", message: "Delete project x?" },
			{
				isCi: () => true,
				stdinIsTty: () => false,
				confirm: async () => {
					prompted = true;
					return false;
				},
			},
		);
		expect(prompted).toBe(false);
	});

	test("refuses when stdin is not a TTY", async () => {
		await expect(
			confirmDestructive(
				{ yes: false, noun: "project", message: "Delete project x?" },
				{
					isCi: () => false,
					stdinIsTty: () => false,
					confirm: async () => true,
				},
			),
		).rejects.toThrow(
			"Deleting a project requires confirmation. Re-run interactively or pass --yes.",
		);
	});

	test("refuses in CI even when stdin is a TTY", async () => {
		await expect(
			confirmDestructive(
				{ yes: false, noun: "branch", message: "Delete branch x?" },
				{
					isCi: () => true,
					stdinIsTty: () => true,
					confirm: async () => true,
				},
			),
		).rejects.toThrow(
			"Deleting a branch requires confirmation. Re-run interactively or pass --yes.",
		);
	});

	test("refuses json and yaml without --yes even on a TTY", async () => {
		await expect(
			confirmDestructive(
				{
					yes: false,
					noun: "project",
					message: "Delete project x?",
					forceYes: true,
				},
				{
					isCi: () => false,
					stdinIsTty: () => true,
					confirm: async () => true,
				},
			),
		).rejects.toThrow(
			"Deleting a project requires confirmation. Re-run interactively or pass --yes.",
		);
	});

	test("prompts on a TTY and throws when the answer is no", async () => {
		await expect(
			confirmDestructive(
				{ yes: false, noun: "project", message: "Delete project x?" },
				{
					isCi: () => false,
					stdinIsTty: () => true,
					confirm: async (message) => {
						expect(message).toBe("Delete project x?");
						return false;
					},
				},
			),
		).rejects.toThrow("Cancelled — project was not deleted.");
	});

	test("prompts on a TTY and returns when the answer is yes", async () => {
		await confirmDestructive(
			{ yes: false, noun: "bucket", message: 'Delete bucket "logs"?' },
			{
				isCi: () => false,
				stdinIsTty: () => true,
				confirm: async () => true,
			},
		);
	});
});
