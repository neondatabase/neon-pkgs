import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createProject,
	deleteProject,
	runCli,
	uniqueProjectName,
} from "./helpers.js";

/**
 * `neon checkout --agent` pins a branch and then pulls its env. The unit suites cover the
 * response shapes against mocks, but with `--no-env-pull` — so the one path they cannot reach
 * is the one that matters most: a real pull that resolves a connection string and lands it on
 * disk, and the `checked_out`/`written` JSON the command assembles from that outcome.
 *
 * This is the regression that guards it. It is the analogue of the `pull_env` step in
 * `init.e2e.test.ts`, scoped to the `checkout --agent` response contract: the field the agent
 * reads (`env_pull`, `env_file`, `pulled`) and the file those fields describe must agree.
 */
describe.sequential("e2e — neon checkout --agent pulls env for real", () => {
	let projectId: string;

	/**
	 * `env pull` writes a connection string and password here, so the whole directory is
	 * throwaway and removed in teardown, credentials included.
	 */
	const workdir = mkdtempSync(join(tmpdir(), "neon-checkout-e2e-"));
	const contextFile = join(workdir, ".neon");

	beforeAll(async () => {
		projectId = await createProject({ name: uniqueProjectName("cli-co") });
	});

	afterAll(async () => {
		rmSync(workdir, { recursive: true, force: true });
		if (projectId) await deleteProject(projectId);
	});

	it("pins the branch and reports the connection string it wrote to disk", async () => {
		const result = await runCli(
			["checkout", "main", "--agent", "--project-id", projectId],
			{ cwd: workdir, contextFile },
		);
		expect(result.code, result.stderr).toBe(0);

		const response = JSON.parse(result.stdout) as {
			status: string;
			env_pull: string;
			env_file?: string;
			pulled?: string[];
			context: { projectId: string; branch: string };
		};

		// The branch is pinned and env actually landed: `written`, not `empty`/`skipped`.
		expect(response.status).toBe("checked_out");
		expect(response.env_pull).toBe("written");
		expect(response.context.projectId).toBe(projectId);
		expect(response.context.branch).toBe("main");

		// The fields the agent reads must name what was written.
		expect(response.env_file).toMatch(/\.env\.local$/);
		expect(response.pulled).toContain("DATABASE_URL");

		// Exit 0 and a `written` status are not enough on their own — the whole point is a
		// connection string on disk, so read the file the response points at and prove it.
		const envFile = join(workdir, ".env.local");
		expect(existsSync(envFile)).toBe(true);
		expect(readFileSync(envFile, "utf8")).toMatch(
			/^DATABASE_URL="?postgresql:\/\/.+/m,
		);
	});

	it("still reports checked_out when the env pull fails — the pin stands", async () => {
		// The design point that motivated this whole change: pinning a branch and
		// pulling its env are separate outcomes. A failed pull must NOT be reported
		// as a top-level failure, because the branch really is pinned — the agent
		// just has to notice `env_pull: "failed"` and re-run `env pull`.
		//
		// Force the pull to fail deterministically without depending on API flakiness:
		// pre-create `.env.local` as a *directory*, so the pull throws EISDIR reading
		// it back — after the pin has already written `.neon`.
		const failWorkdir = mkdtempSync(
			join(tmpdir(), "neon-checkout-e2e-fail-"),
		);
		mkdirSync(join(failWorkdir, ".env.local"));
		const failContext = join(failWorkdir, ".neon");

		const result = await runCli(
			["checkout", "main", "--agent", "--project-id", projectId],
			{ cwd: failWorkdir, contextFile: failContext },
		);

		try {
			// Exit 0: a failed pull is a soft failure. The pin succeeded, so the
			// command does not fail the process — the outcome is carried in the JSON
			// (`env_pull: "failed"`), which is the field an agent must branch on.
			expect(result.code, result.stderr).toBe(0);
			const response = JSON.parse(result.stdout) as {
				status: string;
				env_pull: string;
				context: { projectId: string; branch: string };
			};
			// The branch was still pinned: checked_out, with env_pull flagging that
			// DATABASE_URL never landed on disk.
			expect(response.status).toBe("checked_out");
			expect(response.env_pull).toBe("failed");
			expect(response.context.projectId).toBe(projectId);
			expect(response.context.branch).toBe("main");
			// The pin is the durable half — it's in `.neon` regardless of the pull.
			expect(JSON.parse(readFileSync(failContext, "utf8")).branch).toBe(
				"main",
			);
		} finally {
			rmSync(failWorkdir, { recursive: true, force: true });
		}
	});
});
