import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "./helpers.js";

/**
 * `neon init --agent` answers with the next step. Snapshot tests pin the
 * strings; this suite checks that asking does not install into the project,
 * and that deleted steps stay unknown.
 */

/**
 * Every variable `detectAgent` and `detectIde` read. Clearing them keeps the
 * run agentless: with an agent id the setup execution path would fetch the
 * skills CLI and install into home and cwd. The default `setup` step under
 * test never executes installs; the scrub keeps that honest if that changes.
 *
 * The value scan in `detectIde` only runs inside the VS Code branch, which
 * these variables gate.
 */
const NO_AGENT_ENV: Record<string, undefined> = {
	CLAUDECODE: undefined,
	CLAUDE_CODE: undefined,
	CLAUDE_CLI: undefined,
	CODEX: undefined,
	CLINE: undefined,
	TERM_PROGRAM: undefined,
	CURSOR_TRACE_ID: undefined,
	CURSOR_EXTENSION_HOST_ROLE: undefined,
	CURSOR_LAYOUT: undefined,
	CURSOR_SPAWNED_BY_EXTENSION_ID: undefined,
	GIT_ASKPASS: undefined,
	VSCODE_GIT_ASKPASS_NODE: undefined,
	VSCODE_PID: undefined,
	VSCODE_CWD: undefined,
};

type PhaseResponse = {
	phase: string;
	status: string;
	nextAction?: {
		type: string;
		reportBack?: { type?: string; command?: string };
		[key: string]: unknown;
	};
};

describe.sequential("e2e — neon init emits a protocol the CLI still accepts", () => {
	const root = mkdtempSync(join(tmpdir(), "neon-init-e2e-"));
	const workdir = join(root, "app");
	const contextFile = join(workdir, ".neon");
	const home = join(root, "home");
	const isolated = {
		env: { ...NO_AGENT_ENV, HOME: home },
		cwd: workdir,
		contextFile,
		json: false,
		apiKey: null,
	};

	beforeAll(() => {
		mkdirSync(workdir);
		mkdirSync(home);
		mkdirSync(join(workdir, ".git"));
		writeFileSync(join(workdir, "pnpm-lock.yaml"), "");
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("answers the setup step with an agent_check and installs nothing by asking", async () => {
		const phase = await runCli(
			["init", "--agent", "--data", JSON.stringify({ step: "setup" })],
			isolated,
		);
		expect(phase.code, phase.stderr).toBe(0);

		const response = JSON.parse(phase.stdout) as PhaseResponse;
		expect(response.phase).toBe("setup");
		expect(response.nextAction?.type).toBe("agent_check");
		expect(response.nextAction?.reportBack?.type).toBe("run_shell_command");
		expect(response.nextAction?.reportBack?.command).toMatch(
			/init --agent/,
		);
		expect(response.nextAction?.reportBack?.command).toContain(
			'"step":"setup"',
		);

		expect(existsSync(join(workdir, ".agents"))).toBe(false);
		expect(existsSync(join(workdir, "skills-lock.json"))).toBe(false);
	});

	it("rejects the removed getting-started step", async () => {
		const result = await runCli(
			[
				"init",
				"--agent",
				"--data",
				JSON.stringify({ step: "getting-started" }),
			],
			isolated,
		);

		expect(result.code).not.toBe(0);
		const failure = JSON.parse(result.stdout) as {
			success: boolean;
			error: string;
		};
		expect(failure.success).toBe(false);
		expect(failure.error).toContain('Unknown step: "getting-started"');
	});

	it("reports an unknown step instead of guessing", async () => {
		const result = await runCli(
			[
				"init",
				"--agent",
				"--data",
				JSON.stringify({ step: "not-a-real-step" }),
			],
			isolated,
		);

		expect(result.code).not.toBe(0);
		const failure = JSON.parse(result.stdout) as {
			success: boolean;
			error: string;
		};
		expect(failure.success).toBe(false);
		expect(failure.error).toContain('Unknown step: "not-a-real-step"');
	});
});
