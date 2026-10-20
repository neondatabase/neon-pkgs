import { describe, expect, it } from "vitest";

import { attachToolingContext, toolingContextOf } from "../tooling_error.js";
import { type McpInstallOutcome, mcpInstallError } from "./mcp.js";
import { type SkillsInstallOutcome, skillsInstallError } from "./skills.js";

describe("skillsInstallError", () => {
	const outcome = (
		cause: unknown,
		overrides: Partial<SkillsInstallOutcome> = {},
	): SkillsInstallOutcome => ({
		scope: "project",
		agents: ["cursor", "claude-code"],
		rows: [
			{
				scope: "this directory",
				skills: "neon, neon-postgres",
				agents: "cursor",
				status: "failed",
				error: "skills CLI failed",
			},
		],
		failed: [
			{
				label: "neon, neon-postgres",
				message: "skills CLI failed:\nnpm error code E403",
				skills: ["neon", "neon-postgres"],
				cause,
			},
		],
		...overrides,
	});

	it("is undefined when nothing failed", () => {
		expect(
			skillsInstallError(outcome(undefined, { failed: [] })),
		).toBeUndefined();
	});

	it("says what was being installed and keeps what the child process reported", () => {
		const cause = new Error("skills CLI failed");
		attachToolingContext(cause, { exitCode: 1, timedOut: false });

		const error = skillsInstallError(outcome(cause));

		expect(toolingContextOf(error)).toEqual({
			step: "skills",
			skills: ["neon", "neon-postgres"],
			agents: ["cursor", "claude-code"],
			scope: "project",
			exitCode: 1,
			timedOut: false,
			errorKinds: ["child_failed"],
		});
	});

	it("reports every reason when the failures differ, and a timeout if any timed out", () => {
		const timedOut = new Error("skills CLI failed");
		attachToolingContext(timedOut, { timedOut: true, signal: "SIGTERM" });
		const denied = new Error("EACCES: permission denied, mkdir");
		attachToolingContext(denied, { exitCode: 1 });
		const failure = (cause: Error, skill: string) => ({
			label: skill,
			message: cause.message,
			skills: [skill],
			cause,
		});

		const error = skillsInstallError(
			outcome(undefined, {
				rows: [
					{ scope: "s", skills: "a", agents: "x", status: "failed" },
					{ scope: "s", skills: "b", agents: "x", status: "failed" },
					{
						scope: "s",
						skills: "c",
						agents: "x",
						status: "installed",
					},
				],
				failed: [failure(timedOut, "a"), failure(denied, "b")],
			}),
		);

		expect(toolingContextOf(error)).toMatchObject({
			errorKinds: ["timeout", "permission_denied"],
			timedOut: true,
			// Each field comes from the first failure that has it.
			signal: "SIGTERM",
			exitCode: 1,
			skills: ["a", "b"],
		});
	});

	it("does not change the message the user sees", () => {
		const error = skillsInstallError(outcome(new Error("x")));
		expect(error?.message).toMatch(
			/^skills CLI failed:\nnpm error code E403\nRetry with: neon skills/,
		);
	});
});

describe("mcpInstallError", () => {
	const outcome = (failedAgents: string[]): McpInstallOutcome => ({
		scope: "global",
		rows: [
			{ agent: "cursor", status: "installed" },
			{
				agent: "codex",
				status: "failed",
				error: "EACCES: permission denied",
			},
		],
		failedAgents,
		url: "https://mcp.neon.tech/mcp",
		auth: "oauth",
	});

	it("is undefined when every agent was written", () => {
		expect(mcpInstallError(outcome([]))).toBeUndefined();
	});

	it("names the agents that failed and why", () => {
		const error = mcpInstallError(outcome(["codex"]));

		expect(error?.message).toBe(
			"Failed to write Neon MCP config for: codex.",
		);
		expect(toolingContextOf(error)).toEqual({
			step: "mcp",
			agents: ["codex"],
			scope: "global",
			detail: "EACCES: permission denied",
		});
	});
});
