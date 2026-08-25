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

import pkg from "../pkg.js";
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
	const home = mkdtempSync(join(tmpdir(), "neon-skills-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "neon-skills-cwd-"));
	const bin = mkdtempSync(join(tmpdir(), "neon-skills-bin-"));
	dirs.push(home, cwd, bin);
	const argvFile = join(bin, "argv.json");
	const envFile = join(bin, "env.json");
	writeFileSync(
		join(bin, "npx"),
		`#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.SKILLS_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
writeFileSync(process.env.SKILLS_ENV_FILE, JSON.stringify({
  cwd: process.cwd(),
  hasDisable: Object.prototype.hasOwnProperty.call(process.env, "DISABLE_TELEMETRY"),
  hasDnt: Object.prototype.hasOwnProperty.call(process.env, "DO_NOT_TRACK"),
}));
process.stdout.write("SKILLS_CLI_STDOUT");
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
			SKILLS_ARGV_FILE: join(bin, "argv.json"),
			SKILLS_ENV_FILE: join(bin, "env.json"),
			DISABLE_TELEMETRY: "1",
			DO_NOT_TRACK: "1",
			...extra,
		},
		snapshot: false as const,
		apiKey: false as const,
		output: "json" as const,
	};
}

describe("neon skills", () => {
	test("installs agent-skills into detected project agents", async ({
		testCliCommand,
	}) => {
		const { home, cwd, bin, argvFile, envFile } = scratch();
		const { stdout } = await testCliCommand(
			["skills", "-y"],
			runOptions(home, cwd, bin),
		);
		expect(stdout).not.toContain("SKILLS_CLI_STDOUT");
		const rows = JSON.parse(stdout);
		expect(rows).toEqual([
			{
				source: "neondatabase/agent-skills",
				skills: "*",
				agents: "cursor",
				status: "installed",
			},
		]);
		expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual([
			"-y",
			"skills",
			"add",
			"neondatabase/agent-skills",
			"--skill",
			"*",
			"--agent",
			"cursor",
			"-y",
			"--metadata",
			JSON.stringify({
				origin: "neon-cli",
				command: "skills",
				version: pkg.version,
			}),
		]);
		expect(JSON.parse(readFileSync(envFile, "utf8"))).toMatchObject({
			cwd: realpathSync(cwd),
			hasDisable: false,
			hasDnt: false,
		});
	});

	test("does not spawn without -y", async ({ testCliCommand }) => {
		const { home, cwd, bin, argvFile } = scratch();
		const { stderr } = await testCliCommand(
			["skills", "--agent", "cursor"],
			{ ...runOptions(home, cwd, bin), code: 1 },
		);
		expect(stderr).toMatch(/Pass -y to install every skill/);
		expect(() => readFileSync(argvFile, "utf8")).toThrow();
	});

	test("rejects skills-CLI-only agents", async ({ testCliCommand }) => {
		const { home, cwd, bin } = scratch();
		const { stderr } = await testCliCommand(
			["skills", "-y", "--agent", "eve"],
			{ ...runOptions(home, cwd, bin), code: 1 },
		);
		expect(stderr).toMatch(/Unknown agent: "eve"/);
	});

	test("skips auth and context enrichment", async ({ testCliCommand }) => {
		const { home, cwd, bin } = scratch();
		writeFileSync(
			join(cwd, ".neon"),
			JSON.stringify({ projectId: "proj-from-neon" }),
		);
		const { stdout, stderr } = await testCliCommand(
			["skills", "-y", "--agent", "cursor"],
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
			"-y",
			"skills",
			"update",
			"-p",
			"-y",
		]);
	});

	test("update --global uses -g", async ({ testCliCommand }) => {
		const { home, cwd, bin, argvFile } = scratch();
		await testCliCommand(
			["skills", "update", "--global", "-y"],
			runOptions(home, cwd, bin),
		);
		expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual([
			"-y",
			"skills",
			"update",
			"-g",
			"-y",
		]);
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

	test("install --global passes -g", async ({ testCliCommand }) => {
		const { home, cwd, bin, argvFile } = scratch();
		await testCliCommand(
			["skills", "-y", "--global", "--agent", "cursor"],
			runOptions(home, cwd, bin),
		);
		expect(JSON.parse(readFileSync(argvFile, "utf8"))).toContain("-g");
	});

	test("names a missing npx", async ({ testCliCommand }) => {
		const { home, cwd } = scratch();
		const empty = mkdtempSync(join(tmpdir(), "neon-skills-empty-"));
		dirs.push(empty);
		const { stderr } = await testCliCommand(
			["skills", "-y", "--agent", "cursor"],
			{
				...runOptions(home, cwd, empty, { PATH: empty }),
				code: 1,
			},
		);
		expect(stderr).toMatch(/npx skills add neondatabase\/agent-skills/);
	});

	test("help lists install and update", async ({ testCliCommand }) => {
		const { home, cwd, bin } = scratch();
		const { stdout, stderr } = await testCliCommand(["skills", "--help"], {
			...runOptions(home, cwd, bin),
		});
		const text = `${stdout}\n${stderr}`;
		expect(text).toMatch(/neondatabase\/agent-skills/);
		expect(text).toMatch(/skills update/);
	});
});
