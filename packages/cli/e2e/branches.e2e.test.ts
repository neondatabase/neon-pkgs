import { apiRequest } from "@neon/e2e-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createProject,
	deleteProject,
	runCli,
	runCliJson,
	uniqueProjectName,
	waitForProjectReady,
} from "./helpers.js";

type BranchPayload = {
	branch: { id: string; name: string };
};

/**
 * Branch, role, database and connection-string commands against one shared project.
 * The project is provisioned through the harness rather than `neon projects create`
 * so a regression there fails its own test instead of this whole file's setup.
 */
describe.sequential("e2e — neon CLI branch commands against the real API", () => {
	let projectId: string;

	beforeAll(async () => {
		projectId = await createProject({ name: uniqueProjectName("cli-br") });
	});

	afterAll(async () => {
		if (projectId) await deleteProject(projectId);
	});

	it("lists the default branch", async () => {
		const branches = await runCliJson<{ id: string; name: string }[]>([
			"branches",
			"list",
			"--project-id",
			projectId,
		]);

		expect(branches.length).toBeGreaterThan(0);
		expect(branches.every((branch) => typeof branch.id === "string")).toBe(
			true,
		);
	});

	it("creates and deletes a branch", async () => {
		const created = await runCliJson<BranchPayload>([
			"branches",
			"create",
			"--project-id",
			projectId,
			"--name",
			"cli-e2e",
		]);
		expect(created.branch.name).toBe("cli-e2e");

		const listed = await runCliJson<{ name: string }[]>([
			"branches",
			"list",
			"--project-id",
			projectId,
		]);
		expect(listed.map((branch) => branch.name)).toContain("cli-e2e");

		const deleted = await runCli([
			"branches",
			"delete",
			created.branch.id,
			"--project-id",
			projectId,
		]);
		expect(deleted.code).toBe(0);

		const after = await runCliJson<{ name: string }[]>([
			"branches",
			"list",
			"--project-id",
			projectId,
		]);
		expect(after.map((branch) => branch.name)).not.toContain("cli-e2e");
	});

	it("prints a usable connection string", async () => {
		const result = await runCli(
			["connection-string", "--project-id", projectId],
			{ json: false },
		);

		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toMatch(/^postgresql:\/\//);
	});

	it("gets a branch by id and by name", async () => {
		const byName = await runCliJson<{ id: string; name: string }>([
			"branches",
			"get",
			"main",
			"--project-id",
			projectId,
		]);
		expect(byName.name).toBe("main");

		const byId = await runCliJson<{ id: string; name: string }>([
			"branches",
			"get",
			byName.id,
			"--project-id",
			projectId,
		]);
		expect(byId.id).toBe(byName.id);
		expect(byId.name).toBe("main");
	});

	/**
	 * Reset replaces a branch's state with its parent's, so the branch's own writes are gone
	 * afterwards. The failure mode is silent data loss rather than an error, which is why the
	 * check is a successful query proving the table is absent — a query that merely *failed*
	 * would also pass if the branch had become unreachable for some unrelated reason.
	 */
	it("discards the branch's own writes, and keeps them under --preserve-under-name", async () => {
		const created = await runCliJson<BranchPayload>([
			"branches",
			"create",
			"--project-id",
			projectId,
			"--name",
			"cli-e2e-reset",
		]);
		const branchId = created.branch.id;

		const psql = (branch: string, sql: string) =>
			runCli(
				["psql", branch, "--project-id", projectId, "--", "-XAtc", sql],
				{ json: false, env: { NEONCTL_PSQL_FALLBACK: "1" } },
			);

		const seeded = await psql(
			branchId,
			"create table reset_probe(id int); insert into reset_probe values (1); select count(*) from reset_probe",
		);
		expect(seeded.code, seeded.stderr).toBe(0);
		expect(seeded.stdout).toContain("1");

		const reset = await runCliJson<{ last_reset_at?: string }>([
			"branches",
			"reset",
			branchId,
			"--project-id",
			projectId,
			"--parent",
		]);
		expect(reset.last_reset_at).toEqual(expect.any(String));
		await waitForProjectReady(projectId);

		const afterReset = await psql(
			branchId,
			"select to_regclass('public.reset_probe') is null",
		);
		expect(afterReset.code, afterReset.stderr).toBe(0);
		expect(afterReset.stdout.trim()).toBe("t");

		// Seed it again, then reset preserving the pre-reset state under a new branch.
		const reseeded = await psql(
			branchId,
			"create table reset_probe(id int); insert into reset_probe values (1)",
		);
		expect(reseeded.code, reseeded.stderr).toBe(0);

		await runCliJson([
			"branches",
			"reset",
			branchId,
			"--project-id",
			projectId,
			"--parent",
			"--preserve-under-name",
			"cli-e2e-preserved",
		]);
		await waitForProjectReady(projectId);

		const branches = await runCliJson<{ id: string; name: string }[]>([
			"branches",
			"list",
			"--project-id",
			projectId,
		]);
		const preservedBranch = branches.find(
			(branch) => branch.name === "cli-e2e-preserved",
		);
		expect(preservedBranch).toBeDefined();

		// Preservation keeps the data, not the compute: the saved branch arrives without an
		// endpoint, so there is nothing to connect to until one is added.
		await apiRequest(`/projects/${projectId}/endpoints`, {
			method: "POST",
			body: {
				endpoint: {
					branch_id: (preservedBranch as { id: string }).id,
					type: "read_write",
				},
			},
		});
		await waitForProjectReady(projectId);

		const preserved = await psql(
			"cli-e2e-preserved",
			"select count(*) from reset_probe",
		);
		expect(preserved.code, preserved.stderr).toBe(0);
		expect(preserved.stdout.trim()).toBe("1");

		const target = await psql(
			branchId,
			"select to_regclass('public.reset_probe') is null",
		);
		expect(target.code, target.stderr).toBe(0);
		expect(target.stdout.trim()).toBe("t");
	});

	it("lists roles and databases for the default branch", async () => {
		const roles = await runCliJson<{ name: string }[]>([
			"roles",
			"list",
			"--project-id",
			projectId,
		]);
		expect(roles.length).toBeGreaterThan(0);

		const databases = await runCliJson<{ name: string }[]>([
			"databases",
			"list",
			"--project-id",
			projectId,
		]);
		expect(databases.length).toBeGreaterThan(0);
	});
});
