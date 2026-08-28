import { describe, expect, test } from "vitest";

import { detectAgent } from "./detect_host.js";

describe("detectAgent", () => {
	test("returns null when no host env is set", () => {
		expect(detectAgent({})).toBeNull();
	});

	test("Claude env beats ambient Cursor and VS Code vars", () => {
		expect(
			detectAgent({
				CLAUDECODE: "1",
				TERM_PROGRAM: "cursor",
				CURSOR_TRACE_ID: "trace",
				VSCODE_PID: "1",
			}),
		).toBe("claude-code");
		expect(
			detectAgent({
				CLAUDE_CODE: "1",
				TERM_PROGRAM: "vscode",
			}),
		).toBe("claude-code");
		expect(
			detectAgent({
				CLAUDE_CLI: "1",
				CURSOR_LAYOUT: "1",
			}),
		).toBe("claude-code");
	});

	test("Codex env beats ambient Cursor vars", () => {
		expect(
			detectAgent({
				CODEX: "1",
				TERM_PROGRAM: "cursor",
				CURSOR_TRACE_ID: "trace",
			}),
		).toBe("codex");
		expect(
			detectAgent({
				CODEX_THREAD_ID: "thread-123",
				TERM_PROGRAM: "cursor",
			}),
		).toBe("codex");
		expect(
			detectAgent({
				CODEX_SESSION_ID: "session-123",
				CURSOR_TRACE_ID: "trace",
			}),
		).toBe("codex");
	});

	test("Cline env beats ambient VS Code vars", () => {
		expect(
			detectAgent({
				CLINE: "1",
				TERM_PROGRAM: "vscode",
				VSCODE_PID: "1",
			}),
		).toBe("cline");
	});

	test("Gemini CLI env beats ambient Cursor vars", () => {
		expect(
			detectAgent({
				GEMINI_CLI: "1",
				TERM_PROGRAM: "cursor",
			}),
		).toBe("gemini-cli");
	});

	test("OpenCode env beats ambient Cursor vars", () => {
		expect(
			detectAgent({
				OPENCODE: "1",
				AGENT: "1",
				TERM_PROGRAM: "cursor",
			}),
		).toBe("opencode");
	});

	test("Goose env beats ambient Cursor vars", () => {
		expect(
			detectAgent({
				GOOSE_TERMINAL: "1",
				TERM_PROGRAM: "cursor",
			}),
		).toBe("goose");
		expect(
			detectAgent({
				AGENT: "goose",
				CURSOR_TRACE_ID: "trace",
			}),
		).toBe("goose");
	});

	test("Cursor from TERM_PROGRAM and Cursor-specific vars", () => {
		expect(detectAgent({ TERM_PROGRAM: "cursor" })).toBe("cursor");
		expect(detectAgent({ CURSOR_TRACE_ID: "trace" })).toBe("cursor");
		expect(detectAgent({ CURSOR_EXTENSION_HOST_ROLE: "host" })).toBe(
			"cursor",
		);
	});

	test("Cursor from askpass / IPC paths", () => {
		expect(
			detectAgent({
				TERM_PROGRAM: "vscode",
				GIT_ASKPASS:
					"/Applications/Cursor.app/Contents/Resources/app/extensions/git/dist/askpass.sh",
			}),
		).toBe("cursor");
		expect(
			detectAgent({
				VSCODE_IPC_HOOK_CLI: "/Users/me/.cursor/hooks.sock",
			}),
		).toBe("cursor");
	});

	test("VS Code from TERM_PROGRAM and VSCODE_*", () => {
		expect(detectAgent({ TERM_PROGRAM: "vscode" })).toBe("vscode");
		expect(detectAgent({ VSCODE_PID: "99" })).toBe("vscode");
		expect(detectAgent({ VSCODE_CWD: "/tmp/app" })).toBe("vscode");
	});

	test("Windsurf from TERM_PROGRAM", () => {
		expect(detectAgent({ TERM_PROGRAM: "windsurf" })).toBe("windsurf");
	});

	test("Zed from TERM_PROGRAM", () => {
		expect(detectAgent({ TERM_PROGRAM: "zed" })).toBe("zed");
	});
});
