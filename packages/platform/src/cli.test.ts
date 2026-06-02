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
	test("--help exits 0 and lists the subcommands", async () => {
		const result = await runCli(["--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("pull");
		expect(result.stdout).toContain("push");
		expect(result.stdout).toContain("branch");
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

	test("pull without an API key + no neonctl credentials exits 1 with a helpful message", async () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId: "proj-e2e" }),
		});
		// Point HOME / USERPROFILE at an empty dir so the credentials.json fallback misses
		// too (the runner's real $HOME might have a real ~/.config/neonctl/credentials.json).
		const emptyHome = setup({ ".keep": "" });
		const result = await runCli(["pull"], {
			cwd: root,
			env: {
				NEON_API_KEY: undefined,
				HOME: emptyHome,
				USERPROFILE: emptyHome,
				NEONCTL_CONFIG_DIR: undefined,
			},
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("NEON_API_KEY");
		expect(result.stderr).toContain("neonctl auth");
	});
});
