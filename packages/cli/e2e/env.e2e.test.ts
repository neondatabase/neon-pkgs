import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRequest } from "@neon/e2e-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEnvFile } from "../src/env_file.js";
import {
	createProject,
	deleteProject,
	runCli,
	uniqueProjectName,
} from "./helpers.js";

describe.sequential("e2e — neon env pull against the real API", () => {
	let projectId: string;
	let branchId: string;
	let cwd: string;

	beforeAll(async () => {
		cwd = mkdtempSync(join(tmpdir(), "neon-env-pull-e2e-"));
		projectId = await createProject({
			name: uniqueProjectName("cli-env"),
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

	it("writes only the env variable selected with -e", async () => {
		const result = await runCli(
			[
				"env",
				"pull",
				"--project-id",
				projectId,
				"--branch",
				branchId,
				"--file",
				".env.selected",
				"-e",
				"DATABASE_URL",
			],
			{ cwd, json: false },
		);

		expect(result.code, result.stderr).toBe(0);
		const env = readEnvFile(join(cwd, ".env.selected"));
		expect(env).toEqual({
			DATABASE_URL: expect.stringMatching(/^postgresql:\/\//),
		});
	});
});
