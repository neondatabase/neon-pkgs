import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

const scratch = (): {
	configDir: string;
	contextFile: string;
	cwd: string;
	home: string;
} => {
	const root = mkdtempSync(join(tmpdir(), "neon-init-e2e-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const configDir = join(root, "config");
	const cwd = join(root, "app");
	mkdirSync(configDir);
	mkdirSync(cwd);
	return {
		configDir,
		contextFile: join(cwd, ".neon"),
		cwd,
		home: root,
	};
};

describe("e2e — neon init", () => {
	it("help names the orchestrator", async () => {
		const dirs = scratch();
		const result = await runCli(["init", "--help"], {
			apiKey: null,
			configDir: dirs.configDir,
			contextFile: dirs.contextFile,
			json: false,
		});
		expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
		expect(`${result.stderr}\n${result.stdout}`).toMatch(/skills update/i);
	});

	it("rejects --data and --agent", async () => {
		const dirs = scratch();
		for (const args of [
			["init", "--data", '{"step":"auth"}'],
			["init", "--agent"],
		]) {
			const result = await runCli(args, {
				apiKey: null,
				configDir: dirs.configDir,
				contextFile: dirs.contextFile,
				json: false,
			});
			expect(result.code, result.stderr).toBe(1);
			expect(result.stderr).toMatch(/Unknown argument/i);
		}
	});

	it("stops when skills fails and does not write .neon", async () => {
		const dirs = scratch();
		writeFileSync(join(dirs.cwd, "README.md"), "app\n");
		const result = await runCli(["init", "-y"], {
			configDir: dirs.configDir,
			contextFile: dirs.contextFile,
			cwd: dirs.cwd,
			json: false,
			env: {
				HOME: dirs.home,
			},
		});
		expect(result.code, result.stdout).not.toBe(0);
		expect(`${result.stderr}\n${result.stdout}`).toMatch(/skills/i);
		expect(existsSync(dirs.contextFile)).toBe(false);
	});
});
