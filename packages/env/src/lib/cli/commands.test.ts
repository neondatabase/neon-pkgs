import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FakeNeonApi } from "../fake-neon-api.js";
import { makeTempRepo, stubCleanNeonEnv } from "../test-utils.js";
import { runEnvRun } from "./commands.js";

const CONFIG_SRC = new URL("../../../../config/src/v1.ts", import.meta.url)
	.pathname;

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});
beforeEach(() => stubCleanNeonEnv());

function setup(files: Record<string, string | null>) {
	const repo = makeTempRepo(files);
	cleanups.push(repo.cleanup);
	return repo.root;
}

function seededFake() {
	const api = new FakeNeonApi();
	const projectId = "proj-env-cli";
	api.seedProject({
		project: {
			id: projectId,
			name: "env-cli-test",
			regionId: "aws-us-east-1",
			pgVersion: 17,
		},
		branches: [
			{ branch: { id: "br-main", name: "main", isDefault: true } },
		],
	});
	return { api, projectId };
}

function policy() {
	return `import { defineConfig } from "${CONFIG_SRC}";
export default defineConfig(() => ({}));`;
}

describe("runEnvRun", () => {
	test("injects DATABASE_URL into the spawned command", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId,
				branchId: "br-main",
			}),
			"neon.ts": policy(),
		});
		const outFile = join(
			mkdtempSync(join(tmpdir(), "neon-env-out-")),
			"url.txt",
		);

		const result = await runEnvRun(
			{
				command: [
					process.execPath,
					"-e",
					`require("node:fs").writeFileSync(${JSON.stringify(outFile)}, process.env.DATABASE_URL ?? "")`,
				],
			},
			{ cwd: root, api },
		);

		expect(result.exitCode).toBe(0);
		expect(existsSync(outFile)).toBe(true);
	});

	test("returns a non-zero exit code with usage when no command is given", async () => {
		const { api } = seededFake();
		const root = setup({ "package.json": "{}" });
		const result = await runEnvRun({ command: [] }, { cwd: root, api });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("neon-env run --");
	});

	test("propagates the child's exit code", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId,
				branchId: "br-main",
			}),
			"neon.ts": policy(),
		});
		const result = await runEnvRun(
			{ command: [process.execPath, "-e", "process.exit(3)"] },
			{ cwd: root, api },
		);
		expect(result.exitCode).toBe(3);
	});
});
