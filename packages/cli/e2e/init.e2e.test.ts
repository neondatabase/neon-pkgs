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
 * `neon init --agent` is a protocol rather than a command that does the work: it answers with
 * what an agent should do next. `neon init` now stops at installing the Neon tooling (MCP
 * server, agent skills, editor extension) and hands the rest off to the agent — it no longer
 * selects an org/project, links, or pulls env. The snapshot tests pin the emitted strings
 * exactly; this suite guards the two things a live run must still get right: the CLI accepts
 * the steps it hands out, and merely *asking* what to do installs nothing into the project.
 */

/**
 * Every variable `detectAgent` and `detectIde` read (`init/detect_agent.ts`). Clearing them
 * keeps the run agentless — which matters for determinism, and because with an agent id the
 * setup execution path would fetch the skills CLI and install skills into the home and working
 * directories. The default `setup` step under test never executes installs, but the scrub
 * keeps that guarantee honest if that ever changes.
 *
 * The value scan at `detect_agent.ts:48` only runs inside the VS Code branch, which these
 * variables gate, so clearing them is sufficient.
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
		[key: string]: unknown;
	};
};

describe.sequential("e2e — neon init emits a protocol the CLI still accepts", () => {
	/**
	 * A throwaway working directory: the phase must not write anything here just for being
	 * asked what to do. Removed in teardown.
	 */
	const workdir = mkdtempSync(join(tmpdir(), "neon-init-e2e-"));
	const contextFile = join(workdir, ".neon");

	beforeAll(() => {
		// Make the workdir a project root so inspection doesn't climb into $TMPDIR's ancestors.
		mkdirSync(join(workdir, ".git"));
		writeFileSync(join(workdir, "pnpm-lock.yaml"), "");
	});

	afterAll(() => {
		rmSync(workdir, { recursive: true, force: true });
	});

	it("answers the setup step with an agent_check and installs nothing by asking", async () => {
		const phase = await runCli(
			["init", "--agent", "--data", JSON.stringify({ step: "setup" })],
			{ env: NO_AGENT_ENV, cwd: workdir, contextFile },
		);
		expect(phase.code, phase.stderr).toBe(0);

		const response = JSON.parse(phase.stdout) as PhaseResponse;
		expect(response.phase).toBe("setup");
		expect(response.nextAction?.type).toBe("agent_check");

		// Asking the phase what to do must not install anything into the working directory.
		expect(existsSync(join(workdir, ".agents"))).toBe(false);
		expect(existsSync(join(workdir, "skills-lock.json"))).toBe(false);
	});

	it("reports an unknown step instead of guessing", async () => {
		const result = await runCli([
			"init",
			"--agent",
			"--data",
			JSON.stringify({ step: "not-a-real-step" }),
		]);

		expect(result.code).not.toBe(0);
		// Agent mode answers in JSON even when it fails, so an agent parsing stdout gets a
		// reason rather than a stack trace on stderr.
		const failure = JSON.parse(result.stdout) as {
			success: boolean;
			error: string;
		};
		expect(failure.success).toBe(false);
		expect(failure.error).toContain('Unknown step: "not-a-real-step"');
	});
});
