import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { makeTempRepo } from "./lib/test-utils.js";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

function setup(files: Record<string, string | null>) {
	const repo = makeTempRepo(files);
	cleanups.push(repo.cleanup);
	return repo.root;
}

interface CliRun {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function runCli(
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CliRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CLI_PATH, ...args], {
			cwd: options.cwd ?? process.cwd(),
			env: { ...process.env, ...options.env },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({ exitCode: code ?? -1, stdout, stderr });
		});
	});
}

// These tests spawn the *built* dist/cli.js because that's what end-users actually invoke
// via `npx neon-ts`. If dist/ isn't built yet, skip rather than fail noisily — the
// monorepo build step covers it before publishing, and the handler-level commands.test.ts
// already exercises the same logic with much faster iteration.
const cliBuilt = existsSync(CLI_PATH);
const describeIfBuilt = cliBuilt ? describe : describe.skip;

describeIfBuilt("neon-ts CLI (e2e, spawns dist/cli.js)", () => {
	test("--help exits 0 and lists the three subcommands", async () => {
		const result = await runCli(["--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("pull");
		expect(result.stdout).toContain("push");
		expect(result.stdout).toContain("context");
	});

	test("--version prints the package version", async () => {
		const result = await runCli(["--version"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});

	test("running with no command exits non-zero with a helpful message", async () => {
		const result = await runCli([]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("--help");
	});

	test("unknown subcommand exits non-zero (strict mode)", async () => {
		const result = await runCli(["delete-everything"]);
		expect(result.exitCode).not.toBe(0);
	});

	test("context subcommand resolves from a .neon/project.json file in cwd", async () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "proj-e2e",
				orgId: "org-e2e",
				branchId: "br-e2e",
			}),
		});
		const result = await runCli(["context"], {
			cwd: root,
			env: { NEON_BRANCH_ID: undefined },
		});
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.projectId).toBe("proj-e2e");
		expect(parsed.branch).toEqual({ kind: "id", value: "br-e2e" });
	});

	test("pull without an API key exits 1 with a helpful message", async () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId: "proj-e2e" }),
		});
		const result = await runCli(["pull"], {
			cwd: root,
			env: { NEON_API_KEY: undefined },
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("NEON_API_KEY");
	});
});
