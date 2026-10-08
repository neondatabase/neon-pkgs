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

	const writePolicy = (minCu: number) =>
		writeFileSync(
			join(cwd, "neon.ts"),
			`export default { branch: () => ({ postgres: { computeSettings: { autoscalingLimitMinCu: ${minCu} } } }) };\n`,
		);

	const deploy = (...flags: string[]) =>
		runCli(
			[
				"deploy",
				...flags,
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

	beforeAll(async () => {
		cwd = mkdtempSync(join(tmpdir(), "neon-deploy-e2e-"));
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

	it("refuses to override drifted settings without a flag", async () => {
		writePolicy(0.5);

		const result = await deploy();

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--update-existing");
	});

	it.each([
		["-y", 0.5],
		["--yes", 0.25],
	])("%s overrides drifted settings like --update-existing", async (flag, minCu) => {
		writePolicy(minCu);

		const result = await deploy(flag);

		expect(result.code, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).dryRun).toBe(false);
	});
});
