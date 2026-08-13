import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredOrgId } from "@neon/e2e-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteProject, runCli, uniqueProjectName } from "./helpers.js";

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
	/** Projects created by driving `neon link`, removed in teardown. */
	const created: string[] = [];
	const orgId = configuredOrgId();

	/**
	 * Everything runs here rather than in the checkout: `neon link` and `env pull` write the
	 * `.neon` context and a connection string into it, and the phase would install skills here
	 * if the scrub above ever stopped working. Removed in teardown, credentials included.
	 */
	const workdir = mkdtempSync(join(tmpdir(), "neon-init-e2e-"));
	const contextFile = join(workdir, ".neon");

	beforeAll(() => {
		// Make the workdir a pnpm project: the emitted install step must follow it, and the
		// `.git` marker stops the lockfile walk from climbing into $TMPDIR's ancestors.
		mkdirSync(join(workdir, ".git"));
		writeFileSync(join(workdir, "pnpm-lock.yaml"), "");
	});

	afterAll(async () => {
		rmSync(workdir, { recursive: true, force: true });
		for (const id of created) {
			if (id) await deleteProject(id);
		}
	});

	/** Strip the emitted `CI= npx -y neon ` prefix and split into CLI args. */
	const emittedArgs = (command: string): string[] => {
		expect(command.startsWith(EMITTED_PREFIX)).toBe(true);
		return command.slice(EMITTED_PREFIX.length).split(/\s+/);
	};

	/** Run one `neon link --agent` turn against the real API, non-interactively. */
	const link = (args: string[]) =>
		runCli(["link", "--agent", ...args], {
			env: { ...NO_AGENT_ENV, CI: "" },
			cwd: workdir,
			contextFile,
		});

	it("hands an agent a link → env sequence that creates and connects a project", async () => {
		if (!orgId) {
			throw new Error(
				"NEON_ORG_ID is required: `neon link` takes an --org-id, and supplying one is the point of this test.",
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
		// The standard flow delegates org/project selection to `neon link`. Pinned so a step
		// disappearing from the flow fails here rather than quietly reducing what runs.
		expect(ids).toEqual(
			expect.arrayContaining([
				"link_project",
				"install_dependencies",
				"pull_env",
				"verify_connection",
			]),
		);

		const linkStep = steps.find((step) => step.id === "link_project");
		const pullStep = steps.find((step) => step.id === "pull_env");
		expect(linkStep?.command).toBe(`${EMITTED_PREFIX}link --agent`);
		expect(pullStep?.command).toBe(`${EMITTED_PREFIX}env pull`);

		// 1. The emitted link command runs and returns a state-machine response — either org
		//    selection or project selection, depending on how many orgs the key can see.
		const first = await runCli(emittedArgs(linkStep?.command ?? ""), {
			env: { ...NO_AGENT_ENV, CI: "" },
			cwd: workdir,
			contextFile,
		});
		expect(first.code, first.stderr).toBe(0);
		const firstStatus = (JSON.parse(first.stdout) as { status: string })
			.status;
		expect(["needs_org", "needs_project"]).toContain(firstStatus);

		// 2. Ask to create a project without a region → the CLI lists the regions to pick from.
		const projectName = uniqueProjectName("init-link");
		const details = await link([
			"--org-id",
			orgId,
			"--project-name",
			projectName,
		]);
		expect(details.code, details.stderr).toBe(0);
		const detailsResp = JSON.parse(details.stdout) as {
			status: string;
			regions?: { id: string; default: boolean }[];
		};
		expect(detailsResp.status).toBe("needs_project_details");
		const region =
			detailsResp.regions?.find((r) => r.default) ??
			detailsResp.regions?.[0];
		expect(region, "link should return at least one region").toBeTruthy();

		// 3. Create + link with the chosen region → status linked, and `.neon` written for us.
		const linked = await link([
			"--org-id",
			orgId,
			"--project-name",
			projectName,
			"--region-id",
			region?.id ?? "",
		]);
		expect(linked.code, linked.stderr).toBe(0);
		const linkedResp = JSON.parse(linked.stdout) as {
			status: string;
			project?: { id: string };
		};
		// Track for teardown the moment we know the id, ahead of the assertions below.
		if (linkedResp.project?.id) created.push(linkedResp.project.id);
		expect(linkedResp.status).toBe("linked");

		// `neon link` records org, project AND branch — the gap the old hand-edited .neon left.
		const context = JSON.parse(readFileSync(contextFile, "utf8")) as {
			orgId?: string;
			projectId?: string;
			branch?: string;
		};
		expect(context.orgId).toBe(orgId);
		expect(context.projectId).toBe(linkedResp.project?.id);
		expect(
			context.branch,
			".neon should pin the created project's branch",
		).toBeTruthy();

		// 4. The emitted pull_env step writes a real connection string to disk.
		const pull = await runCli(emittedArgs(pullStep?.command ?? ""), {
			env: { ...NO_AGENT_ENV, CI: "" },
			cwd: workdir,
			contextFile,
		});
		expect(pull.code, pull.stderr).toBe(0);
		const envFile = join(workdir, ".env.local");
		expect(existsSync(envFile)).toBe(true);
		expect(readFileSync(envFile, "utf8")).toMatch(
			/^DATABASE_URL="?postgresql:\/\/.+/m,
		);
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
