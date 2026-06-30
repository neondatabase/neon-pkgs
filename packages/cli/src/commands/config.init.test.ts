import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { test } from "../test_utils/fixtures";
import { initCmd } from "./config";

describe("config init", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "neonctl-config-init-"));
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	test("creates a starter neon.ts when the project has none", async () => {
		await initCmd({ cwd: workspace, install: false });

		const content = readFileSync(join(workspace, "neon.ts"), "utf8");
		expect(content).toContain(
			'import { defineConfig } from "@neondatabase/config/v1"',
		);
		expect(content).toContain("export default defineConfig({");
		expect(content).toContain("auth: false");
		expect(content).toContain('ttl: "7d"');
	});

	test("leaves an existing Neon config file untouched", async () => {
		const original = "export default { auth: true };\n";
		writeFileSync(join(workspace, "neon.ts"), original);

		await initCmd({ cwd: workspace, install: false });

		expect(readFileSync(join(workspace, "neon.ts"), "utf8")).toBe(original);
	});

	test("installs the missing config packages with the detected package manager", async () => {
		const calls: { cmd: string; args: string[]; cwd: string }[] = [];

		await initCmd({
			cwd: workspace,
			install: true,
			run: (cmd, args, cwd) => {
				calls.push({ cmd, args, cwd });
				return Promise.resolve(true);
			},
		});

		expect(calls).toHaveLength(1);
		// npm spells it `install`, pnpm/yarn/bun use `add` — assert on the packages,
		// which are the same regardless of the resolved package manager.
		expect(calls[0].args).toEqual(
			expect.arrayContaining([
				"@neondatabase/config",
				"@neondatabase/env",
			]),
		);
		expect(calls[0].cwd).toBe(workspace);
	});

	test("only installs the packages that aren't already declared", async () => {
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({
				dependencies: { "@neondatabase/config": "^0.8.1" },
			}),
		);
		const calls: string[][] = [];

		await initCmd({
			cwd: workspace,
			install: true,
			run: (_cmd, args) => {
				calls.push(args);
				return Promise.resolve(true);
			},
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("@neondatabase/env");
		expect(calls[0]).not.toContain("@neondatabase/config");
	});

	test("does nothing to install when both packages are already declared", async () => {
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({
				dependencies: {
					"@neondatabase/config": "^0.8.1",
					"@neondatabase/env": "^0.8.1",
				},
			}),
		);
		const calls: string[][] = [];

		await initCmd({
			cwd: workspace,
			run: (_cmd, args) => {
				calls.push(args);
				return Promise.resolve(true);
			},
		});

		expect(calls).toHaveLength(0);
	});

	test("--no-install scaffolds but never runs an installer", async () => {
		const calls: string[][] = [];

		await initCmd({
			cwd: workspace,
			install: false,
			run: (_cmd, args) => {
				calls.push(args);
				return Promise.resolve(true);
			},
		});

		expect(calls).toHaveLength(0);
		expect(existsSync(join(workspace, "neon.ts"))).toBe(true);
	});

	// End-to-end: `config init` must run with NO auth and NO network — it only
	// scaffolds locally. Pointing the CLI at an unreachable host proves that
	// neither the global auth middleware nor `fillSingleProject` reached out (a
	// regression in either offline guard would turn this into a connection error).
	test("runs offline end to end and scaffolds into the working directory", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["config", "init", "--no-install"], {
			unreachableHost: true,
			code: 0,
			cwd: workspace,
		});

		const content = readFileSync(join(workspace, "neon.ts"), "utf8");
		expect(content).toContain("@neondatabase/config/v1");
	});
});
