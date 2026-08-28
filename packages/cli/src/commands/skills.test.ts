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
import strip from "strip-ansi";
import { afterEach, describe, expect } from "vitest";

import pkg from "../pkg.js";
import {
	AGENT_SKILLS_SOURCE,
	defaultSkillEntries,
	NEON_SKILL_CATALOG,
	PLATFORMS_SKILLS_SOURCE,
} from "../skills/catalog.js";
import { skillsInstallableAgents } from "../skills/targets.js";
import { test } from "../test_utils/fixtures";

const defaultSkillIds = defaultSkillEntries().map((entry) => entry.skill);

const skillArgv = (ids: readonly string[]): string[] =>
	ids.flatMap((id) => ["--skill", id]);

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function scratch(opts: { projectCursor?: boolean } = {}): {
	home: string;
	cwd: string;
	bin: string;
	argvFile: string;
	envFile: string;
} {
	const home = mkdtempSync(join(tmpdir(), "neon-skills-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "neon-skills-cwd-"));
	const bin = mkdtempSync(join(tmpdir(), "neon-skills-bin-"));
	dirs.push(home, cwd, bin);
	const argvFile = join(bin, "argv.json");
	const envFile = join(bin, "env.json");
	writeFileSync(
		join(bin, "npx"),
		`#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const argvFile = process.env.SKILLS_ARGV_FILE;
let all = [];
try {
  const parsed = JSON.parse(readFileSync(argvFile, "utf8"));
  all = Array.isArray(parsed) && parsed.every((item) => Array.isArray(item))
    ? parsed
    : [parsed];
} catch {}
all.push(process.argv.slice(2));
writeFileSync(argvFile, JSON.stringify(all));
writeFileSync(process.env.SKILLS_ENV_FILE, JSON.stringify({
  cwd: process.cwd(),
  hasDisable: Object.prototype.hasOwnProperty.call(process.env, "DISABLE_TELEMETRY"),
  hasDnt: Object.prototype.hasOwnProperty.call(process.env, "DO_NOT_TRACK"),
  hasNeonKey: Object.prototype.hasOwnProperty.call(process.env, "NEON_API_KEY"),
}));
if (process.env.SKILLS_CHILD_STDOUT) {
  process.stdout.write(process.env.SKILLS_CHILD_STDOUT);
}
if (process.env.SKILLS_CHILD_STDERR) {
  process.stderr.write(process.env.SKILLS_CHILD_STDERR);
}
if (process.env.SKILLS_CHILD_EXIT) {
  process.exit(Number(process.env.SKILLS_CHILD_EXIT));
}
`,
	);
	chmodSync(join(bin, "npx"), 0o755);
	if (opts.projectCursor !== false) {
		mkdirSync(join(cwd, ".cursor"));
	}
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
			SKILLS_ARGV_FILE: join(bin, "argv.json"),
			SKILLS_ENV_FILE: join(bin, "env.json"),
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

describe("neon skills", () => {
	test("installs default skills into detected project agents", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin, argvFile, envFile } = scratch();
		const { stdout } = await testCliCommand(
			["skills", "-y"],
			runOptions(home, cwd, bin),
		);
		const rows = JSON.parse(stdout);
		expect(rows).toEqual([
			{
				scope: "this directory",
				skills: defaultSkillIds.join(", "),
				agents: "cursor",
				status: "installed",
			},
		]);
		expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual([
			[
				"-y",
				"skills",
				"add",
				"neondatabase/agent-skills",
				...skillArgv(defaultSkillIds),
				"--agent",
				"cursor",
				"-y",
				"--metadata",
				JSON.stringify({
					origin: "neon-cli",
					command: "skills",
					version: pkg.version,
				}),
			],
		]);
		expect(JSON.parse(readFileSync(argvFile, "utf8"))).toHaveLength(1);
		expect(JSON.parse(readFileSync(envFile, "utf8"))).toMatchObject({
			cwd: realpathSync(cwd),
			hasDisable: false,
			hasDnt: false,
			hasNeonKey: false,
		});
	});

	test("installs into the host CLI agent when the project has no folders", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin, argvFile } = scratch({
			projectCursor: false,
		});
		const { stdout } = await testCliCommand(
			["skills", "-y"],
			runOptions(home, cwd, bin, { CLAUDECODE: "1" }),
		);
		expect(JSON.parse(stdout)[0].agents).toBe("claude-code");
		expect(JSON.parse(readFileSync(argvFile, "utf8"))[0]).toEqual(
			expect.arrayContaining(["--agent", "claude-code"]),
		);
	});

	test("-y with no project folders and no host fails", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin } = scratch({ projectCursor: false });
		const { stderr } = await testCliCommand(["skills", "-y"], {
			...runOptions(home, cwd, bin),
			code: 1,
		});
		expect(stderr).toMatch(/No coding agents detected in this project/);
		expect(stderr).toMatch(/omit -y in a terminal/);
		expect(stderr).not.toMatch(/Pass --agent/);
	});

	test("does not spawn without -y", async ({ testCliCommand }) => {
		const { home, cwd, bin, argvFile } = scratch();
		const { stderr } = await testCliCommand(["skills"], {
			...runOptions(home, cwd, bin),
			code: 1,
		});
		expect(stderr).toMatch(/Pass -y to install the default skills/);
		expect(() => readFileSync(argvFile, "utf8")).toThrow();
	});

	test("installs named skills and routes platforms to its repo", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin, argvFile } = scratch();
		const { stdout } = await testCliCommand(
			["skills", "-s", "neon", "-s", "neon-postgres-agent-platforms"],
			runOptions(home, cwd, bin),
		);
		expect(JSON.parse(stdout)).toEqual([
			{
				scope: "this directory",
				skills: "neon",
				agents: "cursor",
				status: "installed",
			},
			{
				scope: "this directory",
				skills: "neon-postgres-agent-platforms",
				agents: "cursor",
				status: "installed",
			},
		]);
		expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual([
			[
				"-y",
				"skills",
				"add",
				"neondatabase/agent-skills",
				"--skill",
				"neon",
				"--agent",
				"cursor",
				"-y",
				"--metadata",
				JSON.stringify({
					origin: "neon-cli",
					command: "skills",
					version: pkg.version,
				}),
			],
			[
				"-y",
				"skills",
				"add",
				"neondatabase/neon-for-agent-platforms",
				"--skill",
				"neon-postgres-agent-platforms",
				"--agent",
				"cursor",
				"-y",
				"--metadata",
				JSON.stringify({
					origin: "neon-cli",
					command: "skills",
					version: pkg.version,
				}),
			],
		]);
	});

	test("rejects unknown skills and --skill *", async ({ testCliCommand }) => {
		const { home, cwd, bin } = scratch();
		const { stderr: unknownSkill } = await testCliCommand(
			["skills", "-y", "-s", "eve"],
			{ ...runOptions(home, cwd, bin), code: 1 },
		);
		expect(unknownSkill).toMatch(/Unknown skill: "eve"/);
		const { stderr: star } = await testCliCommand(
			["skills", "-y", "-s", "*"],
			{ ...runOptions(home, cwd, bin), code: 1 },
		);
		expect(star).toMatch(/does not accept --skill \*/);
	});

	test("skips auth and context enrichment", async ({ testCliCommand }) => {
		const { home, cwd, bin } = scratch();
		writeFileSync(
			join(cwd, ".neon"),
			JSON.stringify({ projectId: "proj-from-neon" }),
		);
		const { stdout, stderr } = await testCliCommand(
			["skills", "-y"],
			runOptions(home, cwd, bin),
		);
		expect(stderr).not.toMatch(/Cannot run interactive auth/);
		expect(stderr).not.toMatch(/Authentication required/);
		expect(JSON.parse(stdout)[0].status).toBe("installed");
	});

	test("update routes to npx skills update -p", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin, argvFile } = scratch();
		const { stdout } = await testCliCommand(
			["skills", "update", "-y"],
			runOptions(home, cwd, bin),
		);
		expect(JSON.parse(stdout)).toEqual([
			{ scope: "this directory", status: "updated" },
		]);
		expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual([
			["-y", "skills", "update", "-p", "-y"],
		]);
	});

	test("update reports none when the child has nothing to update", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin } = scratch();
		const { stdout } = await testCliCommand(
			["skills", "update", "-y"],
			runOptions(home, cwd, bin, {
				SKILLS_CHILD_STDOUT:
					"\u001b[38;5;145mChecking for skill updates…\u001b[0m\nNo project skills to update.\n",
			}),
		);
		expect(JSON.parse(stdout)).toEqual([
			{
				scope: "this directory",
				status: "none",
				detail: "No project skills to update.",
			},
		]);
	});

	test("update detail is the result line after progress", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin } = scratch();
		const { stdout } = await testCliCommand(
			["skills", "update", "-y"],
			runOptions(home, cwd, bin, {
				SKILLS_CHILD_STDOUT:
					"Checking for skill updates…\nUpdating for: Universal\nRefreshing 1 skill(s)…\n✓ Updated 1 skill(s)\n",
			}),
		);
		expect(JSON.parse(stdout)).toEqual([
			{
				scope: "this directory",
				status: "updated",
				detail: "✓ Updated 1 skill(s)",
			},
		]);
	});

	test("update --global none reads the lock-file no-op", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin } = scratch();
		const { stdout } = await testCliCommand(
			["skills", "update", "--global", "-y"],
			runOptions(home, cwd, bin, {
				SKILLS_CHILD_STDOUT:
					"Checking for skill updates…\nNo global skills tracked in lock file.\n",
			}),
		);
		expect(JSON.parse(stdout)).toEqual([
			{
				scope: "user-level",
				status: "none",
				detail: "No global skills tracked in lock file.",
			},
		]);
	});

	test("update --global uses -g", async ({ testCliCommand }) => {
		const { home, cwd, bin, argvFile } = scratch();
		await testCliCommand(
			["skills", "update", "--global", "-y"],
			runOptions(home, cwd, bin),
		);
		expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual([
			["-y", "skills", "update", "-g", "-y"],
		]);
	});

	test("update rejects --skill before spawn", async ({ testCliCommand }) => {
		const { home, cwd, bin, argvFile } = scratch();
		const { stderr } = await testCliCommand(
			["skills", "update", "-y", "--skill", "neon"],
			{ ...runOptions(home, cwd, bin), code: 1 },
		);
		expect(stderr).toMatch(/does not take --skill/);
		expect(() => readFileSync(argvFile, "utf8")).toThrow();
	});

	test("update help does not advertise --agent", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin } = scratch();
		const { stdout, stderr } = await testCliCommand(
			["skills", "update", "--help"],
			runOptions(home, cwd, bin),
		);
		const text = `${stdout}\n${stderr}`;
		expect(text).toMatch(/skills update/);
		expect(text).not.toMatch(/--agent/);
		expect(text).not.toMatch(/--skill/);
		expect(text).not.toMatch(/-y, -y/);
	});

	test("update without -y fails before spawn", async ({ testCliCommand }) => {
		const { home, cwd, bin, argvFile } = scratch();
		const { stderr } = await testCliCommand(["skills", "update"], {
			...runOptions(home, cwd, bin),
			code: 1,
		});
		expect(stderr).toMatch(/Pass -y to update installed skills/);
		expect(() => readFileSync(argvFile, "utf8")).toThrow();
	});

	test("install --global passes -g and names user-level scope", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin, argvFile } = scratch();
		mkdirSync(join(home, ".cursor"));
		const { stdout } = await testCliCommand(
			["skills", "-y", "--global"],
			runOptions(home, cwd, bin),
		);
		expect(JSON.parse(readFileSync(argvFile, "utf8"))[0]).toContain("-g");
		expect(JSON.parse(stdout)[0].scope).toBe("user-level");
		expect(JSON.parse(stdout)[0]).not.toHaveProperty("source");
	});

	test("failed install keeps the child dump out of the table", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin } = scratch();
		const dump =
			"npm error code ENOENT npm error syscall spawn sh npm error path /tmp/x";
		const { stdout, stderr } = await testCliCommand(["skills", "-y"], {
			...runOptions(home, cwd, bin, {
				SKILLS_CHILD_EXIT: "1",
				SKILLS_CHILD_STDERR: dump,
			}),
			code: 1,
		});
		const row = JSON.parse(stdout)[0];
		expect(row.status).toBe("failed");
		expect(row.error).toBe("skills CLI failed");
		expect(row.error).not.toContain("syscall");
		expect(stderr).toMatch(/Retry with: neon skills -s claimable-postgres/);
		expect(stderr).toMatch(/-y/);
		expect(stderr).not.toMatch(/--agent/);
		expect(stderr).not.toMatch(/neondatabase\/agent-skills/);
		expect(stderr.match(/Retry with:/g)?.length).toBe(1);
		expect(stderr).not.toMatch(/Command failed with exit code/);
		expect(stderr.match(/syscall spawn sh/g)?.length).toBe(1);
	});

	test("failed update retries the neon command", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin } = scratch();
		const { stderr } = await testCliCommand(["skills", "update", "-y"], {
			...runOptions(home, cwd, bin, {
				SKILLS_CHILD_EXIT: "1",
				SKILLS_CHILD_STDERR: "boom",
			}),
			code: 1,
		});
		expect(stderr).toMatch(/Retry with: neon skills update -y/);
		expect(stderr).not.toMatch(/npx /);
	});

	test("failed update --global retries with --global", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin } = scratch();
		const { stderr } = await testCliCommand(
			["skills", "update", "--global", "-y"],
			{
				...runOptions(home, cwd, bin, {
					SKILLS_CHILD_EXIT: "1",
					SKILLS_CHILD_STDERR: "boom",
				}),
				code: 1,
			},
		);
		expect(stderr).toMatch(/Retry with: neon skills update --global -y/);
		expect(stderr).not.toMatch(/npx /);
	});

	test("failed multi-source retry names every failed skill", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin } = scratch();
		const { stderr } = await testCliCommand(
			["skills", "-s", "neon", "-s", "neon-postgres-agent-platforms"],
			{
				...runOptions(home, cwd, bin, {
					SKILLS_CHILD_EXIT: "1",
					SKILLS_CHILD_STDERR: "boom",
				}),
				code: 1,
			},
		);
		expect(stderr).toMatch(
			/Retry with: neon skills -s neon -s neon-postgres-agent-platforms -y/,
		);
	});

	test("failed --global retry keeps user-level scope", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin } = scratch();
		mkdirSync(join(home, ".cursor"));
		const { stderr } = await testCliCommand(["skills", "-y", "--global"], {
			...runOptions(home, cwd, bin, {
				SKILLS_CHILD_EXIT: "1",
				SKILLS_CHILD_STDERR: "boom",
			}),
			code: 1,
		});
		expect(stderr).toMatch(/Retry with: neon skills -s claimable-postgres/);
		expect(stderr).toMatch(/--global -y/);
		expect(stderr).not.toMatch(/--agent/);
	});

	test("names a missing npx", async ({ testCliCommand }) => {
		const { home, cwd } = scratch();
		const empty = mkdtempSync(join(tmpdir(), "neon-skills-empty-"));
		dirs.push(empty);
		const { stderr } = await testCliCommand(["skills", "-y"], {
			...runOptions(home, cwd, empty, { PATH: empty }),
			code: 1,
		});
		expect(stderr).toMatch(/needs npx \(Node\.js\) to run the skills CLI/);
		expect(stderr).not.toMatch(/neondatabase\/agent-skills/);
	});

	test("help lists install and update", async ({ testCliCommand }) => {
		const { home, cwd, bin } = scratch();
		const { stdout, stderr } = await testCliCommand(["skills", "--help"], {
			...runOptions(home, cwd, bin),
		});
		const flat = strip(`${stdout}\n${stderr}`).replace(/\s+/g, " ");
		const compact = flat.replace(/\s+/g, "");
		expect(flat).toMatch(/-s, --skill/);
		expect(flat).toMatch(/skills update/);
		expect(flat).not.toMatch(/-y, -y/);
		for (const agent of skillsInstallableAgents()) {
			expect(compact).toContain(agent);
		}
		expect(compact).toContain(AGENT_SKILLS_SOURCE);
		expect(compact).toContain(PLATFORMS_SKILLS_SOURCE);
		expect(compact.split(AGENT_SKILLS_SOURCE).length - 1).toBe(1);
		for (const row of NEON_SKILL_CATALOG) {
			expect(compact).toContain(row.skill);
		}
		expect(compact).toContain("exceptneon-postgres-agent-platforms");
		expect(flat).toContain("Detected agents");
		expect(flat).toContain("skills -y -s neon -s neon-ai-gateway");
	});

	test("--agent names -y instead of unknown argument", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin } = scratch({ projectCursor: false });
		const { stderr } = await testCliCommand(
			["skills", "--agent", "cursor"],
			{ ...runOptions(home, cwd, bin), code: 1 },
		);
		expect(stderr).toMatch(/has no --agent/);
		expect(stderr).toMatch(/Pass -y to use detected agents/);
		expect(stderr).not.toMatch(/Unknown argument: agent/);
	});
});
