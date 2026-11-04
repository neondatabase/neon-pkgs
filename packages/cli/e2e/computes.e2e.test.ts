import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createProject,
	deleteProject,
	runCli,
	runCliJson,
	uniqueProjectName,
	waitForProjectReady,
} from "./helpers.js";

type Compute = {
	id: string;
	branch_id: string;
	type: "read_write" | "read_only";
	current_state: string;
	autoscaling_limit_min_cu: number;
	autoscaling_limit_max_cu: number;
};

/**
 * `neon postgres computes` against one shared project. Mutations wait for their operations by
 * default, so each assertion reads the state the API reports after the change was applied.
 */
describe.sequential("e2e — neon postgres computes against the real API", () => {
	let projectId: string;
	let primary: Compute;

	beforeAll(async () => {
		projectId = await createProject({ name: uniqueProjectName("cli-cmp") });
	});

	afterAll(async () => {
		if (projectId) await deleteProject(projectId);
	});

	it("lists the project's computes and gets one by id", async () => {
		const computes = await runCliJson<Compute[]>([
			"postgres",
			"computes",
			"list",
			"--project-id",
			projectId,
		]);
		expect(computes).toHaveLength(1);
		primary = computes[0];
		expect(primary.type).toBe("read_write");

		const fetched = await runCliJson<Compute>([
			"pg",
			"computes",
			"get",
			primary.id,
			"--project-id",
			projectId,
		]);
		expect(fetched.id).toBe(primary.id);
		expect(fetched.branch_id).toBe(primary.branch_id);
	});

	it("updates the compute size", async () => {
		const updated = await runCliJson<Compute>([
			"postgres",
			"computes",
			"update",
			primary.id,
			"--project-id",
			projectId,
			"--cu",
			"0.25-1",
		]);
		expect(updated.autoscaling_limit_min_cu).toBe(0.25);
		expect(updated.autoscaling_limit_max_cu).toBe(1);
	});

	it("suspends, starts, and restarts the compute", async () => {
		await waitForProjectReady(projectId);
		const suspended = await runCliJson<Compute>([
			"postgres",
			"computes",
			"suspend",
			primary.id,
			"--project-id",
			projectId,
		]);
		expect(suspended.current_state).toBe("idle");

		const started = await runCliJson<Compute>([
			"postgres",
			"computes",
			"start",
			primary.id,
			"--project-id",
			projectId,
		]);
		expect(started.current_state).toBe("active");

		const restarted = await runCliJson<Compute>([
			"lakebase",
			"endpoints",
			"restart",
			primary.id,
			"--project-id",
			projectId,
		]);
		expect(restarted.current_state).toBe("active");
	});

	it("deletes a read-only compute", async () => {
		const added = await runCliJson<{ id: string }>([
			"branches",
			"add-compute",
			primary.branch_id,
			"--project-id",
			projectId,
		]);
		await waitForProjectReady(projectId);

		const deleted = await runCli([
			"postgres",
			"computes",
			"delete",
			added.id,
			"--project-id",
			projectId,
		]);
		expect(deleted.code, deleted.stderr).toBe(0);

		const remaining = await runCliJson<Compute[]>([
			"postgres",
			"computes",
			"list",
			"--project-id",
			projectId,
			"--branch",
			primary.branch_id,
		]);
		expect(remaining.map((compute) => compute.id)).toEqual([primary.id]);
	});

	it("reaches roles through postgres the same way as the top-level command", async () => {
		const args = ["list", "--project-id", projectId];
		const nested = await runCliJson<{ name: string }[]>([
			"postgres",
			"roles",
			...args,
		]);
		const topLevel = await runCliJson<{ name: string }[]>([
			"roles",
			...args,
		]);
		expect(nested).toEqual(topLevel);
		expect(nested.length).toBeGreaterThan(0);
	});
});
