import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { apiRequest } from "@neon/e2e-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createProject,
	deleteProject,
	runCli,
	uniqueProjectName,
	waitForProjectReady,
} from "./helpers.js";

const FIXTURE = resolve(import.meta.dirname, "fixtures", "function-env");
const POLICY = join(FIXTURE, "neon.ts");
const READY_TIMEOUT_MS = 90_000;

type FunctionInfo = {
	invocation_url: string;
	active_deployment?: { id: string; environment?: string[] };
};

/**
 * Declared Function env (`{ required: true }`, …) against the real deploy API, which treats
 * each deployment's environment as a patch: an omitted key keeps its value and `""`
 * deletes it.
 */
describe.sequential("e2e — declared Function env", () => {
	let projectId: string;
	let branchId: string;
	let tmp: string;

	const target = (branch = branchId) => [
		"--project-id",
		projectId,
		"--branch",
		branch,
	];

	const deploy = (envFile: string, branch = branchId) =>
		runCli(
			[
				"deploy",
				"-y",
				...target(branch),
				"--config",
				POLICY,
				"--env",
				envFile,
				"--no-env-pull",
			],
			{ cwd: FIXTURE },
		);

	const envFile = (name: string, contents: string): string => {
		const path = join(tmp, name);
		writeFileSync(path, contents);
		return path;
	};

	const getFunction = async (
		slug: string,
		branch = branchId,
	): Promise<FunctionInfo> => {
		const result = await runCli(
			["functions", "get", slug, ...target(branch)],
			{
				cwd: FIXTURE,
			},
		);
		if (result.code !== 0) {
			throw new Error(`functions get ${slug}: ${result.stderr}`);
		}
		return JSON.parse(result.stdout) as FunctionInfo;
	};

	const invoke = async (slug: string): Promise<unknown> => {
		const { invocation_url } = await getFunction(slug);
		const deadline = Date.now() + READY_TIMEOUT_MS;
		let last = "no response";
		while (Date.now() < deadline) {
			const response = await fetch(invocation_url);
			if (response.ok) return response.json();
			last = `HTTP ${response.status}: ${await response.text()}`;
			await new Promise((wait) => setTimeout(wait, 2_000));
		}
		throw new Error(`${slug} never answered 200. Last: ${last}`);
	};

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "neon-function-env-e2e-"));
		projectId = await createProject({
			name: uniqueProjectName("cli-function-env"),
		});
		const { branches } = await apiRequest<{
			branches: { id: string; default?: boolean }[];
		}>(`/projects/${projectId}/branches`);
		const branch = branches.find((candidate) => candidate.default);
		if (!branch) throw new Error("project has no default branch");
		branchId = branch.id;

		const first = await deploy(
			envFile(
				"all.env",
				"SECRET_A=a\nSECRET_B=b\nOPTIONAL_A=o\nPROD_A=p\n",
			),
		);
		if (first.code !== 0) {
			throw new Error(
				`neon deploy exited ${first.code}:\n${first.stderr}`,
			);
		}
	}, 600_000);

	afterAll(async () => {
		if (projectId) await deleteProject(projectId);
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	});

	it("each Function evaluates neon.ts without the other Function's secret", async () => {
		expect(await invoke("alpha")).toEqual({
			SECRET_A: "a",
			OPTIONAL_A: "o",
			PROD_A: "p",
			RATE_A: "1",
		});
		expect(await invoke("beta")).toEqual({ SECRET_B: "b" });
	});

	it("an unset optional is removed from the deployment", async () => {
		const result = await deploy(
			envFile("secrets.env", "SECRET_A=a\nSECRET_B=b\nPROD_A=p\n"),
		);
		expect(result.code).toBe(0);
		const names = (await getFunction("alpha")).active_deployment
			?.environment;
		expect([...(names ?? [])].sort()).toEqual([
			"PROD_A",
			"RATE_A",
			"SECRET_A",
		]);
	});

	it("a default-branch deploy with required variables unset fails before anything deploys", async () => {
		const before = (await getFunction("beta")).active_deployment?.id;
		const result = await deploy(envFile("missing.env", "SECRET_A=a\n"));
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain(
			'Environment variable "PROD_A" for function "alpha" is required and unset.',
		);
		expect(result.stderr).toContain(
			'Environment variable "SECRET_B" for function "beta" is required and unset.',
		);
		expect((await getFunction("beta")).active_deployment?.id).toBe(before);
	});

	it("a non-default branch deploys without a variable required only on the default branch", async () => {
		const { branch } = await apiRequest<{ branch: { id: string } }>(
			`/projects/${projectId}/branches`,
			{
				method: "POST",
				body: {
					branch: { name: "preview" },
					endpoints: [{ type: "read_write" }],
				},
			},
		);
		await waitForProjectReady(projectId);
		const result = await deploy(
			envFile("preview.env", "SECRET_A=a\nSECRET_B=b\n"),
			branch.id,
		);
		expect(result.code).toBe(0);
		const names = (await getFunction("alpha", branch.id)).active_deployment
			?.environment;
		expect([...(names ?? [])].sort()).toEqual(["RATE_A", "SECRET_A"]);
	});

	it("neon env pull needs none of the secrets", async () => {
		const file = join(tmp, ".env.pulled");
		const result = await runCli(
			["env", "pull", ...target(), "--config", POLICY, "--file", file],
			{ cwd: FIXTURE, json: false },
		);
		expect(result.code).toBe(0);
	});
});
