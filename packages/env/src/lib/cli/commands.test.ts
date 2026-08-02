import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FakeNeonApi } from "../fake-neon-api.js";
import { makeTempRepo, stubCleanNeonEnv } from "../test-utils.js";
import { runEnvExport, runEnvRun } from "./commands.js";

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
export default defineConfig({});`;
}

describe("runEnvRun", () => {
	// Regression: `neonctl link` writes a flat `.neon` pinning the branch *name*
	// (`branch: "main"`), not a `br-…` id. fetchEnv must resolve that to the branch.
	test("injects DATABASE_URL when .neon pins the branch by name", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon": JSON.stringify({
				projectId,
				branch: "main",
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

describe("runEnvExport", () => {
	test("prints the branch env as dotenv lines by default", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId,
				branchId: "br-main",
			}),
			"neon.ts": policy(),
		});

		const result = await runEnvExport(
			{ format: "dotenv" },
			{ cwd: root, api },
		);

		expect(result.exitCode).toBe(0);
		// The connection string contains `=` (e.g. ?sslmode=require), so the value is quoted.
		expect(result.stdout).toMatch(/^DATABASE_URL="postgresql:\/\//m);
		expect(result.stdout.endsWith("\n")).toBe(true);
	});

	test("prints valid JSON with --format json", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId,
				branchId: "br-main",
			}),
			"neon.ts": policy(),
		});

		const result = await runEnvExport(
			{ format: "json" },
			{ cwd: root, api },
		);

		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout) as Record<string, string>;
		expect(parsed.DATABASE_URL).toMatch(/^postgresql:\/\//);
	});

	test("fails with a non-zero exit code when no project/branch can be resolved", async () => {
		const { api } = seededFake();
		const root = setup({ "package.json": "{}" });

		const result = await runEnvExport(
			{ format: "json" },
			{ cwd: root, api },
		);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("could not resolve");
	});

	// `@neon/config` raises a library-shaped error ("this package never reads
	// NEON_API_KEY on your behalf") that is the opposite of what a `neon-env` user needs
	// to hear, since this CLI does read it. No `api` is injected here, so the real
	// adapter is constructed — and refuses — before any request is made.
	test("explains this CLI's own key chain when no key resolves", async () => {
		const { projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon": JSON.stringify({ projectId, branch: "main" }),
			"neon.ts": policy(),
		});

		const result = await runEnvExport({ format: "json" }, { cwd: root });

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("No Neon API key");
		expect(result.stderr).toContain("--api-key");
		expect(result.stderr).toContain("NEON_API_KEY");
		expect(result.stderr).toContain("credentials.json");
		// The library's phrasing must not leak through to a CLI user.
		expect(result.stderr).not.toContain("This package never reads");
	});
});
