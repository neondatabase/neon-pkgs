import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

const scratch = (): {
	configDir: string;
	contextFile: string;
	cwd: string;
	home: string;
} => {
	const root = mkdtempSync(join(tmpdir(), "neon-init-e2e-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const configDir = join(root, "config");
	const cwd = join(root, "app");
	mkdirSync(configDir);
	mkdirSync(cwd);
	return {
		configDir,
		contextFile: join(cwd, ".neon"),
		cwd,
		home: root,
	};
};

describe("e2e — neon init", () => {
	it("help names the orchestrator", async () => {
		const dirs = scratch();
		const result = await runCli(["init", "--help"], {
			apiKey: null,
			configDir: dirs.configDir,
			contextFile: dirs.contextFile,
			json: false,
		});
		expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
		expect(`${result.stderr}\n${result.stdout}`).toMatch(/scaffold/i);
	});

	it("rejects --data", async () => {
		const dirs = scratch();
		const result = await runCli(["init", "--data", '{"step":"auth"}'], {
			apiKey: null,
			configDir: dirs.configDir,
			contextFile: dirs.contextFile,
			json: false,
		});
		expect(result.code, result.stderr).toBe(1);
		expect(result.stderr).toMatch(/was removed/i);
	});

	it("stops when no agents are detected and does not write .neon", async () => {
		const dirs = scratch();
		writeFileSync(join(dirs.cwd, "README.md"), "app\n");
		const result = await runCli(["init", "-y"], {
			apiKey: null,
			configDir: dirs.configDir,
			contextFile: dirs.contextFile,
			cwd: dirs.cwd,
			json: false,
			env: {
				HOME: dirs.home,
				CLAUDECODE: undefined,
				CLAUDE_CODE: undefined,
				CLAUDE_CLI: undefined,
				CODEX: undefined,
				CODEX_THREAD_ID: undefined,
				CODEX_SESSION_ID: undefined,
				GEMINI_CLI: undefined,
				OPENCODE: undefined,
				GOOSE_TERMINAL: undefined,
				AGENT: undefined,
				CLINE: undefined,
				TERM_PROGRAM: undefined,
				CURSOR_TRACE_ID: undefined,
				CURSOR_EXTENSION_HOST_ROLE: undefined,
				CURSOR_LAYOUT: undefined,
				CURSOR_SPAWNED_BY_EXTENSION_ID: undefined,
				GIT_ASKPASS: undefined,
				VSCODE_GIT_ASKPASS_NODE: undefined,
				VSCODE_GIT_ASKPASS_MAIN: undefined,
				VSCODE_IPC_HOOK_CLI: undefined,
				VSCODE_PID: undefined,
				VSCODE_CWD: undefined,
			},
		});
		expect(result.code, result.stdout).not.toBe(0);
		expect(`${result.stderr}\n${result.stdout}`).toMatch(
			/No coding agents detected/i,
		);
		expect(existsSync(dirs.contextFile)).toBe(false);
	});
});
