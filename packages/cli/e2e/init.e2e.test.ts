import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { npmEnvForIsolatedHome } from "../src/test_utils/npm_env.js";
import {
	createProject,
	deleteProject,
	e2eTest,
	orgArgs,
	runCli,
	uniqueProjectName,
} from "./helpers.js";

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

const isolatedAgentEnv = (
	home: string,
): Record<string, string | undefined> => ({
	HOME: home,
	USERPROFILE: home,
	XDG_CONFIG_HOME: join(home, ".config"),
	APPDATA: join(home, "AppData"),
	CODEX_HOME: join(home, ".codex"),
	NEON_API_KEY: undefined,
	CLAUDECODE: undefined,
	CLAUDE_CODE_CHILD_SESSION: undefined,
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
	...npmEnvForIsolatedHome(),
});

describe("e2e — neon init", () => {
	it("help names Recommended setup", async () => {
		const dirs = scratch();
		const result = await runCli(["init", "--help"], {
			apiKey: null,
			configDir: dirs.configDir,
			contextFile: dirs.contextFile,
			json: false,
		});
		expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
		expect(`${result.stderr}\n${result.stdout}`).toMatch(
			/Recommended setup/,
		);
		expect(`${result.stderr}\n${result.stdout}`).toMatch(/-y/);
		expect(`${result.stderr}\n${result.stdout}`).toMatch(/-a, --agent/);
		expect(`${result.stderr}\n${result.stdout}`).toMatch(/--no-config/);
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

	it("unattended Recommended without auth skips link and does not scaffold", async () => {
		const dirs = scratch();
		writeFileSync(join(dirs.cwd, "README.md"), "app\n");
		const result = await runCli(["init", "-y", "--no-config"], {
			apiKey: null,
			configDir: dirs.configDir,
			contextFile: dirs.contextFile,
			cwd: dirs.cwd,
			json: false,
			env: isolatedAgentEnv(dirs.home),
		});
		expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
		expect(`${result.stderr}\n${result.stdout}`).toMatch(
			/No coding agents detected/i,
		);
		expect(`${result.stderr}\n${result.stdout}`).toContain(
			"https://neon.com/signup",
		);
		expect(`${result.stderr}\n${result.stdout}`).toMatch(/neon link/);
		expect(`${result.stderr}\n${result.stdout}`).toMatch(
			/neon claim create/,
		);
		expect(existsSync(dirs.contextFile)).toBe(false);
		expect(existsSync(join(dirs.cwd, "src"))).toBe(false);
	});

	it("empty -y does not scaffold a starter template", async () => {
		const dirs = scratch();
		const result = await runCli(
			["init", "-y", "--no-config", "--no-link"],
			{
				apiKey: null,
				configDir: dirs.configDir,
				contextFile: dirs.contextFile,
				cwd: dirs.cwd,
				json: false,
				env: isolatedAgentEnv(dirs.home),
			},
		);
		expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
		expect(readdirSync(dirs.cwd)).toEqual([]);
		expect(existsSync(join(dirs.cwd, "package.json"))).toBe(false);
	});

	e2eTest(
		"Custom skip links an existing project without prompts",
		async ({ track }) => {
			const dirs = scratch();
			writeFileSync(join(dirs.cwd, "package.json"), "{}\n");
			const projectId = await createProject({
				name: uniqueProjectName("cli-init"),
			});
			track(projectId);
			try {
				const result = await runCli(
					[
						"init",
						"--agent-setup",
						"skip",
						"--no-config",
						"--project-id",
						projectId,
						...orgArgs(),
					],
					{
						configDir: dirs.configDir,
						contextFile: dirs.contextFile,
						cwd: dirs.cwd,
						json: false,
						env: isolatedAgentEnv(dirs.home),
					},
				);
				expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(
					0,
				);
				expect(existsSync(dirs.contextFile)).toBe(true);
				expect(result.stdout).toMatch(/linked/i);
			} finally {
				await deleteProject(projectId);
			}
		},
	);
});
