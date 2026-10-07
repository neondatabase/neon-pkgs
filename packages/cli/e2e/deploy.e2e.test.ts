import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRequest } from "@neon/e2e-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createProject,
	deleteProject,
	runCli,
	uniqueProjectName,
} from "./helpers.js";

describe.sequential("e2e — neon deploy against the real API", () => {
	let projectId: string;
	let branchId: string;
	let cwd: string;

	beforeAll(async () => {
		cwd = mkdtempSync(join(tmpdir(), "neon-deploy-e2e-"));
		writeFileSync(join(cwd, "neon.ts"), "export default {};\n");
		projectId = await createProject({
			name: uniqueProjectName("cli-deploy"),
		});
		const { branches } = await apiRequest<{
			branches: { id: string; default?: boolean }[];
		}>(`/projects/${projectId}/branches`);
		const branch = branches.find((candidate) => candidate.default);
		if (!branch) throw new Error("project has no default branch");
		branchId = branch.id;
	});

	afterAll(async () => {
		if (projectId) await deleteProject(projectId);
		if (cwd) rmSync(cwd, { recursive: true, force: true });
	});

	it.each([["-y"], ["--yes"]])("accepts %s", async (flag) => {
		const result = await runCli(
			[
				"deploy",
				flag,
				"--project-id",
				projectId,
				"--branch",
				branchId,
				"--config",
				join(cwd, "neon.ts"),
				"--no-env-pull",
			],
			{ cwd },
		);

		expect(result.code, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).dryRun).toBe(false);
	});
});
