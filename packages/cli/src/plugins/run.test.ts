import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
	neonPluginsRetryCommand,
	PLUGIN_SOURCE,
	pluginsAddArgs,
	pluginsChildEnv,
	pluginsCliFailureMessage,
	runPluginsCli,
} from "./run.js";

describe("pluginsAddArgs", () => {
	test("adds the Neon plugin into one mapped target", () => {
		const args = pluginsAddArgs({
			target: "cursor",
			global: false,
		});
		expect(PLUGIN_SOURCE).toBe("neondatabase/agent-skills");
		expect(args).toEqual([
			"-y",
			"plugins",
			"add",
			"neondatabase/agent-skills",
			"-t",
			"cursor",
			"-s",
			"project",
			"-y",
		]);
		expect(args.join(" ")).not.toMatch(/-t \*/);
		expect(args.filter((part) => part === "-t")).toHaveLength(1);
	});

	test("passes -s user for user-level installs", () => {
		expect(pluginsAddArgs({ target: "vscode", global: true })).toEqual([
			"-y",
			"plugins",
			"add",
			"neondatabase/agent-skills",
			"-t",
			"vscode",
			"-s",
			"user",
			"-y",
		]);
	});

	test("rejects an empty target", () => {
		expect(() => pluginsAddArgs({ target: "", global: false })).toThrow(
			/needs a -t target/,
		);
	});
});

describe("pluginsChildEnv", () => {
	test("drops telemetry blockers and keeps the rest", () => {
		const env = pluginsChildEnv({
			PATH: "/usr/bin",
			HOME: "/tmp/home",
			DISABLE_TELEMETRY: "1",
			DO_NOT_TRACK: "1",
			NEON_API_KEY: "secret",
			NeOn_ApI_KeY: "also-secret",
			CI: "true",
		});
		expect(env.PATH).toBe("/usr/bin");
		expect(env.HOME).toBe("/tmp/home");
		expect(env.CI).toBe("true");
		expect(env).not.toHaveProperty("DISABLE_TELEMETRY");
		expect(env).not.toHaveProperty("DO_NOT_TRACK");
		expect(env).not.toHaveProperty("NEON_API_KEY");
		expect(env).not.toHaveProperty("NeOn_ApI_KeY");
	});
});

describe("pluginsCliFailureMessage", () => {
	test("names a timeout before child output", () => {
		expect(
			pluginsCliFailureMessage({
				stdout: "",
				stderr: "boom",
				timedOut: true,
			}),
		).toBe("plugins CLI timed out after 120 seconds:\nboom");
	});

	test("names a timeout when the child printed nothing", () => {
		expect(
			pluginsCliFailureMessage({
				stdout: "",
				stderr: "",
				timedOut: true,
			}),
		).toBe("plugins CLI timed out after 120 seconds.");
	});

	test("uses the requested timeout length", () => {
		expect(
			pluginsCliFailureMessage({
				stdout: "",
				stderr: "",
				timedOut: true,
				timeoutMs: 400,
			}),
		).toBe("plugins CLI timed out after 1 second.");
	});

	test("does not use execa shortMessage", () => {
		expect(
			pluginsCliFailureMessage({
				stdout: "",
				stderr: "",
			}),
		).toBe("plugins CLI failed.");
	});

	test("timeout text does not name the plugin source", () => {
		expect(
			pluginsCliFailureMessage({
				stdout: "",
				stderr: "banner",
				timedOut: true,
			}),
		).not.toMatch(/neondatabase\//);
	});
});

describe("neonPluginsRetryCommand", () => {
	test("names agents and user-level scope on the neon command", () => {
		expect(
			neonPluginsRetryCommand({
				agents: ["cursor", "claude-code"],
				global: true,
			}),
		).toBe("neon plugins --agent cursor --agent claude-code --global -y");
	});

	test("is the neon command, not npx", () => {
		expect(
			neonPluginsRetryCommand({ agents: ["cursor"], global: false }),
		).toBe("neon plugins --agent cursor -y");
		expect(
			neonPluginsRetryCommand({ agents: ["cursor"], global: false }),
		).not.toMatch(/npx /);
		expect(
			neonPluginsRetryCommand({ agents: ["cursor"], global: false }),
		).not.toMatch(/neondatabase\//);
	});
});

describe("runPluginsCli timeout", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("kills npx and a grandchild that holds the pipe", async () => {
		const bin = mkdtempSync(join(tmpdir(), "neon-plugins-npx-"));
		dirs.push(bin);
		writeFileSync(
			join(bin, "npx"),
			`#!/usr/bin/env node
const { spawn } = require("node:child_process");
process.stdout.write("plugins banner\\n");
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
setInterval(() => {}, 1000);
`,
		);
		chmodSync(join(bin, "npx"), 0o755);
		const started = Date.now();
		await expect(
			runPluginsCli({
				args: [
					"-y",
					"plugins",
					"add",
					"x",
					"-t",
					"cursor",
					"-s",
					"project",
					"-y",
				],
				cwd: bin,
				timeoutMs: 400,
				env: {
					...process.env,
					PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
				},
			}),
		).rejects.toThrow(/timed out after 1 second/);
		expect(Date.now() - started).toBeLessThan(4000);
	});
});
