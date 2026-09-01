import { describe, expect, it } from "vitest";
import { getCliAgent, getGithubEnvVars } from "./env";

describe("getCliAgent", () => {
	it("attributes a Claude Code child session", () => {
		expect(getCliAgent({ CLAUDE_CODE_CHILD_SESSION: "1" })).toBe(
			"claude-code",
		);
	});

	it("attributes a Codex thread", () => {
		expect(
			getCliAgent({
				CODEX_CI: "1",
				CODEX_THREAD_ID: "thread-123",
			}),
		).toBe("codex");
	});

	it("attributes a Codex session", () => {
		expect(
			getCliAgent({
				CODEX_CI: "1",
				CODEX_SESSION_ID: "session-123",
			}),
		).toBe("codex");
	});

	it("does not attribute a user-initiated Codex shell command", () => {
		expect(
			getCliAgent({
				CODEX_THREAD_ID: "thread-123",
				CODEX_SESSION_ID: "session-123",
			}),
		).toBeUndefined();
	});

	it("does not attribute disabled or empty direct markers", () => {
		expect(
			getCliAgent({
				CLAUDE_CODE_CHILD_SESSION: "false",
				CODEX_THREAD_ID: "",
				CODEX_SESSION_ID: " ",
			}),
		).toBeUndefined();
	});

	it("does not attribute ambient or sandbox utility markers", () => {
		expect(
			getCliAgent({
				CLAUDECODE: "1",
				CLAUDE_CODE: "1",
				CLAUDE_CLI: "1",
				CODEX: "1",
				CODEX_CI: "1",
				CODEX_SANDBOX: "seatbelt",
				CODEX_SANDBOX_NETWORK_DISABLED: "1",
			}),
		).toBeUndefined();
	});

	it("omits attribution when nested agent markers conflict", () => {
		expect(
			getCliAgent({
				CLAUDE_CODE_CHILD_SESSION: "1",
				CODEX_CI: "1",
				CODEX_THREAD_ID: "thread-123",
			}),
		).toBeUndefined();
	});
});

describe("getGithubEnvVars", () => {
	it("success all keys", () => {
		const env = {
			GITHUB_ACTION_PATH: "1",
			GITHUB_REPOSITORY: "2",
			GITHUB_RUN_ID: "3",
			GITHUB_RUN_NUMBER: "4",
			GITHUB_SERVER_URL: "5",
			GITHUB_WORKFLOW_REF: "6",
			RUNNER_ARCH: "7",
			RUNNER_ENVIRONMENT: "8",
			RUNNER_OS: "9",
			unrelated: "unrelated",
		};

		const ret = {
			GITHUB_ACTION_PATH: "1",
			GITHUB_REPOSITORY: "2",
			GITHUB_RUN_ID: "3",
			GITHUB_RUN_NUMBER: "4",
			GITHUB_SERVER_URL: "5",
			GITHUB_WORKFLOW_REF: "6",
			RUNNER_ARCH: "7",
			RUNNER_ENVIRONMENT: "8",
			RUNNER_OS: "9",
		};

		expect(getGithubEnvVars(env)).toEqual(ret);
	});

	it("empty all keys", () => {
		expect(getGithubEnvVars({})).toEqual({});
	});

	it("action path", () => {
		expect(
			getGithubEnvVars({
				GITHUB_ACTION_PATH:
					"/home/runner/work/_actions/neondatabase/create-branch-action/v5",
			}),
		).toEqual({
			GITHUB_ACTION_PATH: "neondatabase/create-branch-action/v5",
		});

		expect(
			getGithubEnvVars({
				GITHUB_ACTION_PATH:
					"/home/runner/actions-runner/_work/actions/neondatabase/create-branch-action/v5",
			}),
		).toEqual({
			GITHUB_ACTION_PATH: "neondatabase/create-branch-action/v5",
		});

		expect(
			getGithubEnvVars({
				GITHUB_ACTION_PATH:
					"C:\\b\\_actions\\neondatabase\\create-branch-action\\v5",
			}),
		).toEqual({
			GITHUB_ACTION_PATH:
				"C:\\b\\_actions\\neondatabase\\create-branch-action\\v5",
		});

		expect(
			getGithubEnvVars({
				GITHUB_ACTION_PATH:
					"/home/runner/work/app/app/./.github/actions/custom-action",
			}),
		).toEqual({
			GITHUB_ACTION_PATH: "custom-action",
		});
	});
});
