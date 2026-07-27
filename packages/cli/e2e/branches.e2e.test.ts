import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createProject,
	deleteProject,
	runCli,
	runCliJson,
	uniqueProjectName,
} from "./helpers.js";

type BranchPayload = {
	branch: { id: string; name: string };
};

/**
 * Branch, role, database and connection-string commands against one shared project.
 * The project is provisioned through the harness rather than `neonctl projects create`
 * so a regression there fails its own test instead of this whole file's setup.
 */
describe.sequential("e2e — neonctl branch commands against the real API", () => {
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
