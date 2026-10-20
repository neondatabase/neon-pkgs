import { execa } from "execa";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toolingContextOf } from "../tooling_error.js";
import { runSkillsCli } from "./run.js";

vi.mock("execa", () => ({ execa: vi.fn() }));

const failure = (fields: Record<string, unknown>) =>
	Object.assign(new Error("Command failed"), {
		shortMessage: "Command failed",
		stderr: "",
		stdout: "",
		...fields,
	});

describe("runSkillsCli failures", () => {
	beforeEach(() => {
		vi.mocked(execa).mockReset();
	});

	it("keeps the exit code, timeout and signal of the child on the error", async () => {
		vi.mocked(execa).mockRejectedValue(
			failure({
				stderr: "npm error code E403",
				exitCode: 1,
				timedOut: true,
				signal: "SIGTERM",
			}),
		);

		const error = await runSkillsCli({ args: ["skills"], cwd: "." }).catch(
			(e: unknown) => e,
		);

		expect((error as Error).message).toBe(
			"skills CLI failed:\nnpm error code E403",
		);
		expect(toolingContextOf(error)).toEqual({
			exitCode: 1,
			timedOut: true,
			signal: "SIGTERM",
		});
	});

	it("still names a missing npx without any context", async () => {
		vi.mocked(execa).mockRejectedValue(
			Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" }),
		);

		const error = await runSkillsCli({ args: ["skills"], cwd: "." }).catch(
			(e: unknown) => e,
		);

		expect((error as Error).message).toMatch(/needs npx \(Node\.js\)/);
	});
});
