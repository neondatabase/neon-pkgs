import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredOrgId } from "@neon/e2e-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createProject,
	deleteProject,
	runCli,
	uniqueProjectName,
} from "./helpers.js";

/**
 * `neon init --agent` is a protocol rather than a command that does the work: it answers with
 * the shell commands an agent should run on the user's behalf. The snapshot tests pin those
 * strings exactly; what no test checks is that the commands still exist and still work. That
 * is the regression this covers — init handing an agent an invocation the CLI no longer
 * accepts, which the agent then reports as a failed setup.
 *
 * The phase under test is `getting-started`, because that is the one a real run reaches: a
 * directory with no Neon connection routes there (`init/orchestrate.ts`), and it is where the
 * org, project and env commands are emitted.
 */

/** The exact prefix the protocol emits. Substituted for the binary under test — and asserted, because a silent change here would make every substitution below a no-op. */
const EMITTED_PREFIX = "CI= npx -y neon ";

/**
 * Every variable `detectAgent` and `detectIde` read (`init/detect_agent.ts`). Clearing them
 * keeps the run agentless, which matters for more than determinism: given an agent id, the
 * phase calls `ensureSkillsUpToDate`, which fetches the skills CLI and installs skills — into
 * the home directory, and into the working directory it is invoked from.
 *
 * This has to be applied to the phase invocation itself, not only to the commands it emits.
 * It was not, once, and the run wrote `.agents/skills/` and `skills-lock.json` into
 * `packages/cli`. Hence also the temp working directory below, and the assertion that nothing
 * was installed into it: a scrub that silently stops working should fail this test rather
 * than reconfigure the machine.
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

type AgentStep = { id: string; description: string; command?: string };

type PhaseResponse = {
	phase: string;
	status: string;
	nextAction?: {
		type: string;
		steps?: AgentStep[];
		onComplete?: { type: string };
		[key: string]: unknown;
	};
};

describe.sequential("e2e — neon init emits commands that work", () => {
	let projectId: string;
	/** Projects the emitted `projects create` produced, removed in teardown. */
	const created: string[] = [];
	const orgId = configuredOrgId();

	/**
	 * Everything runs here rather than in the checkout: `env pull` writes a connection string
	 * and password into it, and the phase would install skills here if the scrub above ever
	 * stopped working. Removed in teardown, credentials included.
	 */
	const workdir = mkdtempSync(join(tmpdir(), "neon-init-e2e-"));
	const contextFile = join(workdir, ".neon");

	beforeAll(async () => {
		projectId = await createProject({
			name: uniqueProjectName("cli-init"),
		});
		writeFileSync(contextFile, `${JSON.stringify({ orgId, projectId })}\n`);
	});

	afterAll(async () => {
		rmSync(workdir, { recursive: true, force: true });
		for (const id of [...created, projectId]) {
			if (id) await deleteProject(id);
		}
	});

	it("hands an agent a working org, project and env sequence", async () => {
		if (!orgId) {
			throw new Error(
				"NEON_ORG_ID is required: the emitted commands take an --org-id, and substituting one is the point of this test.",
			);
		}

		const phase = await runCli(
			[
				"init",
				"--agent",
				"--data",
				JSON.stringify({ step: "getting-started" }),
			],
			{ env: NO_AGENT_ENV, cwd: workdir, contextFile },
		);
		expect(phase.code, phase.stderr).toBe(0);
		const response = JSON.parse(phase.stdout) as PhaseResponse;

		// Nothing may have been installed by asking the phase what to do.
		expect(existsSync(join(workdir, ".agents"))).toBe(false);
		expect(existsSync(join(workdir, "skills-lock.json"))).toBe(false);

		expect(response.nextAction?.type).toBe("agent_action");
		const steps = response.nextAction?.steps ?? [];
		const ids = steps.map((step) => step.id);
		// The sequence a user is walked through. Pinned so a step disappearing from the
		// flow fails here rather than quietly reducing what this test exercises.
		expect(ids).toEqual(
			expect.arrayContaining([
				"select_org",
				"select_or_create_project",
				"create_project_if_needed",
				"pull_env",
			]),
		);

		const executed: string[] = [];
		for (const step of steps) {
			if (!step.command) continue;

			// `npm install` steps belong to the user's package manager, not to us. Assert we
			// recognise them rather than running an install on the machine.
			if (!step.command.startsWith(EMITTED_PREFIX)) {
				expect(step.command).toMatch(/^npm install/);
				continue;
			}

			const args = step.command
				.slice(EMITTED_PREFIX.length)
				.replace("<org-id>", orgId)
				.replace("<project-name>", uniqueProjectName("init-emitted"))
				.split(/\s+/);

			const result = await runCli(args, {
				env: { ...NO_AGENT_ENV, CI: "" },
				cwd: workdir,
				contextFile,
			});
			expect(result.code, `${step.command}\n${result.stderr}`).toBe(0);
			executed.push(step.id);

			if (step.id === "select_org") {
				const orgs = JSON.parse(result.stdout) as { id: string }[];
				expect(orgs.map((org) => org.id)).toContain(orgId);
			}
			if (step.id === "select_or_create_project") {
				// The phase tells the agent to filter this list, so it has to be parseable
				// and it has to contain the project the agent would pick.
				const projects = JSON.parse(result.stdout) as { id: string }[];
				expect(projects.map((project) => project.id)).toContain(
					projectId,
				);
			}
			if (step.id === "create_project_if_needed") {
				const { project } = JSON.parse(result.stdout) as {
					project: { id: string; name: string };
				};
				created.push(project.id);
				expect(project.name).toMatch(/^neon-ts-e2e-/);
			}
			if (step.id === "pull_env") {
				// Exit 0 is not the outcome that matters: `env pull` succeeds when it
				// resolves nothing. The whole sequence exists to leave a connection string
				// on disk, so read the file it wrote.
				const envFile = join(workdir, ".env.local");
				expect(existsSync(envFile)).toBe(true);
				expect(readFileSync(envFile, "utf8")).toMatch(
					/^DATABASE_URL="?postgresql:\/\/.+/m,
				);
			}
		}

		// Every command the flow emits for us must have run, or this test proved less than
		// it claims. `pull_env` last: it is the step that produces the connection string the
		// whole sequence exists to obtain.
		expect(executed).toEqual([
			"select_org",
			"select_or_create_project",
			"create_project_if_needed",
			"pull_env",
		]);
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
