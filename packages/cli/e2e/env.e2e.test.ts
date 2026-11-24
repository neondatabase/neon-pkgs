import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

	describe.sequential("the pull bundled into link and checkout", () => {
		const scratch = (): string => mkdtempSync(join(cwd, "bundled-"));
		const inDir = (dir: string) => ({
			cwd: dir,
			contextFile: join(dir, ".neon"),
			json: false,
		});

		beforeAll(async () => {
			const created = await runCli(
				[
					"buckets",
					"create",
					"uploads",
					"--project-id",
					projectId,
					"--branch",
					branchId,
				],
				{ json: false },
			);
			expect(created.code, created.stderr).toBe(0);
		});

		it("leaves a user's own AWS_* alone and says so", async () => {
			const dir = scratch();
			const own = [
				"AWS_ACCESS_KEY_ID=AKIAOWNKEY",
				"AWS_SECRET_ACCESS_KEY=own-secret",
				"AWS_ENDPOINT_URL_S3=https://acct.r2.cloudflarestorage.com",
			];
			writeFileSync(join(dir, ".env"), `${own.join("\n")}\n`);

			const linked = await runCli(
				["link", "--project-id", projectId],
				inDir(dir),
			);

			expect(linked.code, linked.stderr).toBe(0);
			const env = readFileSync(join(dir, ".env"), "utf8");
			for (const line of own) expect(env).toContain(`${line}\n`);
			expect(env).toMatch(/^DATABASE_URL=/m);
			expect(linked.stderr).toMatch(
				/Not pulled\s+Object Storage, to keep the AWS_\* keys already in \S*\.env\. Use `\S+ env pull -s object-storage` to replace them\./,
			);
		});

		it("link into a fresh directory still writes Object Storage", async () => {
			const dir = scratch();

			const linked = await runCli(
				["link", "--project-id", projectId],
				inDir(dir),
			);

			expect(linked.code, linked.stderr).toBe(0);
			expect(linked.stderr).not.toMatch(/Not pulled/);
			const env = readEnvFile(join(dir, ".env.local"));
			expect(new URL(env.AWS_ENDPOINT_URL_S3 ?? "").hostname).toMatch(
				new RegExp(`^${branchId}\\.`),
			);
			expect(env.AWS_ACCESS_KEY_ID).toBeDefined();
		});

		it("checkout moves the Object Storage and AI Gateway variables the file has to the new branch", async () => {
			const dir = scratch();
			const linked = await runCli(
				["link", "--project-id", projectId, "--no-env-pull"],
				inDir(dir),
			);
			expect(linked.code, linked.stderr).toBe(0);
			const pulled = await runCli(["env", "pull"], inDir(dir));
			expect(pulled.code, pulled.stderr).toBe(0);

			const checkedOut = await runCli(
				["checkout", "e2e-bundled", "--create"],
				inDir(dir),
			);

			expect(checkedOut.code, checkedOut.stderr).toBe(0);
			expect(checkedOut.stderr).not.toMatch(/Removed|Not pulled/);
			const env = readEnvFile(join(dir, ".env.local"));
			const newBranch = env.NEON_BRANCH_ID;
			expect(newBranch).toMatch(/^br-/);
			expect(newBranch).not.toBe(branchId);
			expect(new URL(env.AWS_ENDPOINT_URL_S3 ?? "").hostname).toMatch(
				new RegExp(`^${newBranch}\\.`),
			);
			expect(
				new URL(env.NEON_AI_GATEWAY_BASE_URL ?? "").hostname,
			).toMatch(new RegExp(`^${newBranch}-`));
			expect(env.NEON_AI_GATEWAY_TOKEN).toBeDefined();
		});
	});
});
