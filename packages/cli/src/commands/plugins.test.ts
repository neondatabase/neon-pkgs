import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";

import { test } from "../test_utils/fixtures";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function scratch(): {
	home: string;
	cwd: string;
	bin: string;
	argvFile: string;
	envFile: string;
} {
	const home = mkdtempSync(join(tmpdir(), "neon-plugins-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "neon-plugins-cwd-"));
	const bin = mkdtempSync(join(tmpdir(), "neon-plugins-bin-"));
	dirs.push(home, cwd, bin);
	const argvFile = join(bin, "argv.json");
	const envFile = join(bin, "env.json");
	writeFileSync(
		join(bin, "npx"),
		`#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const argvFile = process.env.PLUGINS_ARGV_FILE;
let all = [];
try {
  const parsed = JSON.parse(readFileSync(argvFile, "utf8"));
  all = Array.isArray(parsed) && parsed.every((item) => Array.isArray(item))
    ? parsed
    : [parsed];
} catch {}
const args = process.argv.slice(2);
all.push(args);
writeFileSync(argvFile, JSON.stringify(all));
writeFileSync(process.env.PLUGINS_ENV_FILE, JSON.stringify({
  cwd: process.cwd(),
  hasDisable: Object.prototype.hasOwnProperty.call(process.env, "DISABLE_TELEMETRY"),
  hasDnt: Object.prototype.hasOwnProperty.call(process.env, "DO_NOT_TRACK"),
  hasNeonKey: Object.prototype.hasOwnProperty.call(process.env, "NEON_API_KEY"),
}));
if (process.env.PLUGINS_CHILD_STDOUT) {
  process.stdout.write(process.env.PLUGINS_CHILD_STDOUT);
}
if (process.env.PLUGINS_CHILD_STDERR) {
  process.stderr.write(process.env.PLUGINS_CHILD_STDERR);
}
const failTarget = process.env.PLUGINS_FAIL_TARGET;
if (failTarget) {
  const t = args.indexOf("-t");
  if (t !== -1 && args[t + 1] === failTarget) {
    process.exit(1);
  }
}
if (process.env.PLUGINS_CHILD_EXIT) {
  process.exit(Number(process.env.PLUGINS_CHILD_EXIT));
}
`,
	);
	chmodSync(join(bin, "npx"), 0o755);
	mkdirSync(join(cwd, ".cursor"));
	return { home, cwd, bin, argvFile, envFile };
}

function runOptions(
	home: string,
	cwd: string,
	bin: string,
	extra: Record<string, string> = {},
) {
	return {
		cwd,
		env: {
			HOME: home,
			CI: "true",
			PATH: `${bin}:${join(process.cwd(), "mocks/bin")}:${process.env.PATH}`,
			PLUGINS_ARGV_FILE: join(bin, "argv.json"),
			PLUGINS_ENV_FILE: join(bin, "env.json"),
			DISABLE_TELEMETRY: "1",
			DO_NOT_TRACK: "1",
			NEON_API_KEY: "should-not-leak",
			...extra,
		},
		snapshot: false as const,
		apiKey: false as const,
		output: "json" as const,
	};
}

describe("neon plugins", () => {
	test("installs neon-postgres into detected project agents", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin, argvFile, envFile } = scratch();
		const { stdout } = await testCliCommand(
			["plugins", "-y"],
			runOptions(home, cwd, bin),
		);
		expect(JSON.parse(stdout)).toEqual([
			{
				scope: "project",
				plugin: "neon-postgres",
				agent: "cursor",
				status: "installed",
			},
		]);
		expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual([
			[
				"-y",
				"plugins",
				"add",
				"neondatabase/agent-skills",
				"-t",
				"cursor",
				"-s",
				"project",
				"-y",
			],
		]);
		expect(JSON.parse(readFileSync(envFile, "utf8"))).toMatchObject({
			cwd: realpathSync(cwd),
			hasDisable: false,
			hasDnt: false,
			hasNeonKey: false,
		});
	});

	test("installs without -y when --agent is set", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin, argvFile } = scratch();
		const { stdout } = await testCliCommand(
			["plugins", "--agent", "cursor"],
			runOptions(home, cwd, bin),
		);
		expect(JSON.parse(stdout)[0].status).toBe("installed");
		expect(JSON.parse(readFileSync(argvFile, "utf8"))).toHaveLength(1);
	});

	test("does not spawn without -y or --agent", async ({ testCliCommand }) => {
		const { home, cwd, bin, argvFile } = scratch();
		const { stderr } = await testCliCommand(["plugins"], {
			...runOptions(home, cwd, bin),
			code: 1,
		});
		expect(stderr).toMatch(/Pass -y to install into detected agents/);
		expect(() => readFileSync(argvFile, "utf8")).toThrow();
	});

	test("spawns once per target and dedupes Claude", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin, argvFile } = scratch();
		const { stdout } = await testCliCommand(
			[
				"plugins",
				"--agent",
				"cursor",
				"--agent",
				"claude",
				"--agent",
				"claude-desktop",
			],
			runOptions(home, cwd, bin),
		);
		expect(JSON.parse(stdout)).toEqual([
			{
				scope: "project",
				plugin: "neon-postgres",
				agent: "cursor",
				status: "installed",
			},
			{
				scope: "project",
				plugin: "neon-postgres",
				agent: "claude-code, claude-desktop",
				status: "installed",
			},
		]);
		expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual([
			[
				"-y",
				"plugins",
				"add",
				"neondatabase/agent-skills",
				"-t",
				"cursor",
				"-s",
				"project",
				"-y",
			],
			[
				"-y",
				"plugins",
				"add",
				"neondatabase/agent-skills",
				"-t",
				"claude-code",
				"-s",
				"project",
				"-y",
			],
		]);
	});

	test("rejects unknown agents and --agent *", async ({ testCliCommand }) => {
		const { home, cwd, bin } = scratch();
		const { stderr: unknownAgent } = await testCliCommand(
			["plugins", "-y", "--agent", "eve"],
			{ ...runOptions(home, cwd, bin), code: 1 },
		);
		expect(unknownAgent).toMatch(/Unknown agent: "eve"/);
		expect(unknownAgent).not.toMatch(/vscode/);
		expect(unknownAgent).not.toMatch(/github-copilot-cli/);
		expect(unknownAgent).not.toMatch(/grok-build/);
		const { stderr: unknownGlobal } = await testCliCommand(
			["plugins", "-y", "--global", "--agent", "eve"],
			{ ...runOptions(home, cwd, bin), code: 1 },
		);
		expect(unknownGlobal).toMatch(/Unknown agent: "eve"/);
		expect(unknownGlobal).toMatch(/vscode/);
		const { stderr: star } = await testCliCommand(
			["plugins", "-y", "--agent", "*"],
			{ ...runOptions(home, cwd, bin), code: 1 },
		);
		expect(star).toMatch(/does not accept --agent \*/);
	});

	test("rejects unknown options and subcommands", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin, argvFile } = scratch();
		const { stderr: pluginFlag } = await testCliCommand(
			["plugins", "--plugin", "neon-postgres"],
			{ ...runOptions(home, cwd, bin), code: 1 },
		);
		expect(pluginFlag).toMatch(/Unknown argument: plugin/);
		expect(() => readFileSync(argvFile, "utf8")).toThrow();
		const { stderr: update } = await testCliCommand(["plugins", "update"], {
			...runOptions(home, cwd, bin),
			code: 1,
		});
		expect(update).toMatch(/Unknown command: update/);
		expect(update).not.toMatch(/neondatabase\/agent-skills/);
	});

	test("skips auth and context enrichment", async ({ testCliCommand }) => {
		const { home, cwd, bin } = scratch();
		writeFileSync(
			join(cwd, ".neon"),
			JSON.stringify({ projectId: "proj-from-neon" }),
		);
		const { stdout, stderr } = await testCliCommand(
			["plugins", "--agent", "cursor"],
			runOptions(home, cwd, bin),
		);
		expect(stderr).not.toMatch(/Cannot run interactive auth/);
		expect(stderr).not.toMatch(/Authentication required/);
		expect(JSON.parse(stdout)[0].status).toBe("installed");
	});

	test("install --global passes -s user", async ({ testCliCommand }) => {
		const { home, cwd, bin, argvFile } = scratch();
		const { stdout } = await testCliCommand(
			["plugins", "-y", "--global", "--agent", "cursor"],
			runOptions(home, cwd, bin),
		);
		expect(JSON.parse(readFileSync(argvFile, "utf8"))[0]).toContain("user");
		expect(JSON.parse(stdout)[0].scope).toBe("user");
	});

	test("vscode requires --global", async ({ testCliCommand }) => {
		const { home, cwd, bin, argvFile } = scratch();
		const { stderr } = await testCliCommand(
			["plugins", "--agent", "vscode"],
			{ ...runOptions(home, cwd, bin), code: 1 },
		);
		expect(stderr).toMatch(/Pass --global/);
		expect(() => readFileSync(argvFile, "utf8")).toThrow();
		const { stdout } = await testCliCommand(
			["plugins", "--global", "--agent", "vscode"],
			runOptions(home, cwd, bin),
		);
		expect(JSON.parse(stdout)[0]).toMatchObject({
			scope: "user",
			agent: "vscode",
			status: "installed",
		});
		expect(JSON.parse(readFileSync(argvFile, "utf8"))[0]).toEqual([
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

	test("failed install keeps the child dump out of the table", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin } = scratch();
		const dump =
			"npm error code ENOENT npm error syscall spawn sh npm error path /tmp/x";
		const { stdout, stderr } = await testCliCommand(
			["plugins", "--agent", "cursor"],
			{
				...runOptions(home, cwd, bin, {
					PLUGINS_CHILD_EXIT: "1",
					PLUGINS_CHILD_STDERR: dump,
				}),
				code: 1,
			},
		);
		const row = JSON.parse(stdout)[0];
		expect(row.status).toBe("failed");
		expect(row.error).toBe("plugins CLI failed");
		expect(row.error).not.toContain("syscall");
		expect(stderr).toMatch(/Retry with: neon plugins --agent cursor -y/);
		expect(stderr).not.toMatch(/neondatabase\/agent-skills/);
		expect(stderr.match(/Retry with:/g)?.length).toBe(1);
		expect(stderr).not.toMatch(/Command failed with exit code/);
		expect(stderr.match(/syscall spawn sh/g)?.length).toBe(1);
	});

	test("partial failure retries only failed targets", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin } = scratch();
		const { stdout, stderr } = await testCliCommand(
			["plugins", "--agent", "cursor", "--agent", "claude-code"],
			{
				...runOptions(home, cwd, bin, {
					PLUGINS_FAIL_TARGET: "claude-code",
					PLUGINS_CHILD_STDERR: "boom",
				}),
				code: 1,
			},
		);
		const rows = JSON.parse(stdout);
		expect(rows[0].status).toBe("installed");
		expect(rows[1].status).toBe("failed");
		expect(stderr).toMatch(
			/Retry with: neon plugins --agent claude-code -y/,
		);
		expect(stderr).not.toMatch(/--agent cursor/);
	});

	test("silent child failure does not print the npx argv", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin } = scratch();
		const { stderr } = await testCliCommand(
			["plugins", "--agent", "cursor"],
			{
				...runOptions(home, cwd, bin, {
					PLUGINS_CHILD_EXIT: "1",
				}),
				code: 1,
			},
		);
		expect(stderr).toMatch(/plugins CLI failed/);
		expect(stderr).toMatch(/Retry with: neon plugins --agent cursor -y/);
		expect(stderr).not.toMatch(/neondatabase\/agent-skills/);
		expect(stderr).not.toMatch(/Command failed with exit code/);
	});

	test("failed --global retry keeps user-level scope", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin } = scratch();
		const { stderr } = await testCliCommand(
			["plugins", "-y", "--global", "--agent", "cursor"],
			{
				...runOptions(home, cwd, bin, {
					PLUGINS_CHILD_EXIT: "1",
					PLUGINS_CHILD_STDERR: "boom",
				}),
				code: 1,
			},
		);
		expect(stderr).toMatch(
			/Retry with: neon plugins --agent cursor --global -y/,
		);
		expect(stderr).not.toMatch(/npx /);
	});

	test("names a missing npx", async ({ testCliCommand }) => {
		const { home, cwd } = scratch();
		const empty = mkdtempSync(join(tmpdir(), "neon-plugins-empty-"));
		dirs.push(empty);
		const { stderr } = await testCliCommand(
			["plugins", "--agent", "cursor"],
			{
				...runOptions(home, cwd, empty, { PATH: empty }),
				code: 1,
			},
		);
		expect(stderr).toMatch(/needs npx \(Node\.js\) to run the plugins CLI/);
		expect(stderr).not.toMatch(/neondatabase\/agent-skills/);
	});

	test("help lists install flags and hides the source", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin } = scratch();
		const { stdout, stderr } = await testCliCommand(["plugins", "--help"], {
			...runOptions(home, cwd, bin),
		});
		const text = `${stdout}\n${stderr}`;
		expect(text).toMatch(/--agent/);
		expect(text).toMatch(/--global/);
		expect(text).not.toMatch(/--plugin/);
		expect(text).not.toMatch(/plugins update/);
		expect(text).not.toMatch(/neondatabase\/agent-skills/);
		expect(text).not.toMatch(/-s user/);
		expect(text).not.toMatch(/-s project/);
		expect(text).not.toMatch(/project-scoped/);
	});
});
