import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createProject,
	deleteProject,
	runCli,
	runCliJson,
	uniqueProjectName,
	waitForProjectReady,
} from "./helpers.js";

type Role = { name: string; password?: string; branch_id: string };

describe.sequential("e2e — neon roles get and reset-password against the real API", () => {
	let projectId: string;

	beforeAll(async () => {
		projectId = await createProject({
			name: uniqueProjectName("cli-role"),
		});
	});

	afterAll(async () => {
		if (projectId) await deleteProject(projectId);
	});

	it("gets a role and resets its password to one that connects", async () => {
		const created = await runCliJson<Role>([
			"roles",
			"create",
			"--project-id",
			projectId,
			"--name",
			"cli_e2e_reset",
		]);
		await waitForProjectReady(projectId);

		const fetched = await runCliJson<Role>([
			"roles",
			"get",
			"cli_e2e_reset",
			"--project-id",
			projectId,
		]);
		expect(fetched.name).toBe("cli_e2e_reset");
		expect(fetched.password).toBeUndefined();

		const reset = await runCliJson<Role>([
			"roles",
			"reset-password",
			"cli_e2e_reset",
			"--project-id",
			projectId,
		]);
		expect(reset.password).toEqual(expect.any(String));
		expect(reset.password).not.toBe(created.password);

		const connectionString = await runCli(
			[
				"connection-string",
				"--project-id",
				projectId,
				"--role-name",
				"cli_e2e_reset",
			],
			{ json: false },
		);
		expect(connectionString.stdout).toContain(
			`cli_e2e_reset:${reset.password}@`,
		);

		const query = await runCli(
			[
				"psql",
				"--project-id",
				projectId,
				"--role-name",
				"cli_e2e_reset",
				"--",
				"-XAtc",
				"select current_user",
			],
			{ json: false, env: { NEONCTL_PSQL_FALLBACK: "1" } },
		);
		expect(query.code, query.stderr).toBe(0);
		expect(query.stdout.trim()).toBe("cli_e2e_reset");
	});
});
