import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import which from "which";
import { pluginsAddArgs } from "../src/plugins/run.js";
import { pluginsTargets } from "../src/plugins/targets.js";
import { npmEnvForIsolatedHome } from "../src/test_utils/npm_env.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

/** A HOME with no agent config and a PATH with only node, npm, npx, and system tools. */
const agentlessMachine = (): { home: string; cwd: string; path: string } => {
	const root = mkdtempSync(join(tmpdir(), "neon-plugins-e2e-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const cwd = join(root, "app");
	const bin = join(root, "bin");
	for (const dir of [home, cwd, bin]) mkdirSync(dir);
	for (const name of ["node", "npm", "npx"]) {
		symlinkSync(which.sync(name), join(bin, name));
	}
	return { home, cwd, path: [bin, "/usr/bin", "/bin"].join(":") };
};

describe("plugins CLI install requirements", () => {
	for (const { target, command } of pluginsTargets()) {
		it(`${target} ${command === undefined ? "installs without an agent CLI" : `needs "${command}"`}`, () => {
			const machine = agentlessMachine();
			if (command !== undefined) {
				expect(
					which.sync(command, { nothrow: true, path: machine.path }),
					`"${command}" must be absent from the test PATH`,
				).toBeNull();
			}
			const result = spawnSync(
				"npx",
				pluginsAddArgs({ target, global: true }),
				{
					cwd: machine.cwd,
					encoding: "utf8",
					timeout: 150_000,
					env: {
						...npmEnvForIsolatedHome(),
						HOME: machine.home,
						PATH: machine.path,
						DISABLE_TELEMETRY: "1",
						DO_NOT_TRACK: "1",
					},
				},
			);
			const output = `${result.stdout}${result.stderr}`;
			if (command === undefined) {
				expect(result.status, output).toBe(0);
			} else {
				expect(result.status, output).not.toBe(0);
				expect(output).toContain(`spawnSync ${command} ENOENT`);
			}
		});
	}
});
