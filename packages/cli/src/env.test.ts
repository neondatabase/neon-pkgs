import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
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

	it("attributes a Cursor agent command", () => {
		expect(getCliAgent({ CURSOR_AGENT: "1" })).toBe("cursor");
	});

	it("does not attribute a Cursor terminal a person opened", () => {
		expect(
			getCliAgent({
				TERM_PROGRAM: "vscode",
				CURSOR_TRACE_ID: "trace-123",
				VSCODE_GIT_ASKPASS_MAIN:
					"/Applications/Cursor.app/Contents/Resources/app/extensions/git/dist/askpass-main.js",
			}),
		).toBeUndefined();
	});

	it("does not attribute a disabled Cursor marker", () => {
		expect(getCliAgent({ CURSOR_AGENT: "0" })).toBeUndefined();
		expect(getCliAgent({ CURSOR_AGENT: "" })).toBeUndefined();
	});

	it("omits attribution when Claude Code runs inside a Cursor agent", () => {
		expect(
			getCliAgent({ CURSOR_AGENT: "1", CLAUDE_CODE_CHILD_SESSION: "1" }),
		).toBeUndefined();
	});

	it("attributes a command run inside OpenCode", () => {
		expect(getCliAgent({ OPENCODE: "1", OPENCODE_PID: "4242" })).toBe(
			"opencode",
		);
	});

	it("attributes a command run inside Gemini CLI", () => {
		expect(getCliAgent({ GEMINI_CLI: "1" })).toBe("gemini-cli");
	});

	it("attributes a command run inside GitHub Copilot CLI", () => {
		expect(
			getCliAgent({
				COPILOT_CLI: "1",
				COPILOT_AGENT_SESSION_ID:
					"9bdc7889-8f55-4682-9ecd-458e83d44d24",
			}),
		).toBe("github-copilot-cli");
	});

	it("attributes a Kilo command as Kilo, not OpenCode", () => {
		expect(
			getCliAgent({ KILO: "1", OPENCODE: "1", KILO_PID: "4242" }),
		).toBe("kilo");
	});

	it.each([
		[{ ANTIGRAVITY_AGENT: "1" }, "antigravity"],
		[{ QWEN_CODE: "1" }, "qwen-code"],
		[{ AMP_CURRENT_THREAD_ID: "T-123" }, "amp"],
		[{ CLINE_ACTIVE: "true" }, "cline"],
		[{ OPENCLAW_SHELL: "exec" }, "openclaw"],
	])("attributes %o as %s", (env, agent) => {
		expect(getCliAgent(env)).toBe(agent);
	});

	it("does not attribute a command typed in OpenClaw's local shell", () => {
		expect(getCliAgent({ OPENCLAW_SHELL: "tui-local" })).toBeUndefined();
	});

	it("falls back to the agent AI_AGENT declares", () => {
		expect(
			getCliAgent({ AI_AGENT: "hermes-agent", HERMES_AGENT: "true" }),
		).toBe("hermes-agent");
		expect(getCliAgent({ AI_AGENT: " Crush " })).toBe("crush");
	});

	it("prefers a specific marker over AI_AGENT", () => {
		expect(getCliAgent({ AI_AGENT: "v0", CURSOR_AGENT: "1" })).toBe(
			"cursor",
		);
	});

	it("drops an AI_AGENT value that is not a short slug", () => {
		expect(getCliAgent({ AI_AGENT: "" })).toBeUndefined();
		expect(getCliAgent({ AI_AGENT: "my agent" })).toBeUndefined();
		expect(getCliAgent({ AI_AGENT: "a".repeat(65) })).toBeUndefined();
	});

	it("does not attribute disabled harness markers", () => {
		expect(getCliAgent({ OPENCODE: "0" })).toBeUndefined();
		expect(getCliAgent({ GEMINI_CLI: "" })).toBeUndefined();
		expect(getCliAgent({ COPILOT_CLI: "false" })).toBeUndefined();
	});

	it("omits attribution when harness markers are nested", () => {
		expect(
			getCliAgent({ OPENCODE: "1", CLAUDE_CODE_CHILD_SESSION: "1" }),
		).toBeUndefined();
		expect(
			getCliAgent({ GEMINI_CLI: "1", COPILOT_CLI: "1" }),
		).toBeUndefined();
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

describe("getTty", () => {
	it("reports no terminal when an agent runs the CLI with piped stdio", async () => {
		const env = pathToFileURL(join(process.cwd(), "dist/env.js")).href;
		const { stdout } = await promisify(execFile)(process.execPath, [
			"--input-type=module",
			"-e",
			`const { getTty } = await import(${JSON.stringify(env)}); process.stdout.write(JSON.stringify(getTty()));`,
		]);
		expect(JSON.parse(stdout)).toEqual({ stdin: false, stdout: false });
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
