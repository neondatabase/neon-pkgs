import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agents } from "add-mcp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { takeCommandSuccessExtras } from "../analytics.js";
import { NEON_MCP_URL } from "../mcp/install.js";
import { handler as mcpHandler } from "./mcp.js";
import { handler as pluginsHandler } from "./plugins.js";
import { handler as skillsHandler } from "./skills.js";

const dirs: string[] = [];
const previousCwd = process.cwd();
const previousPath = process.env.PATH ?? "";
const originalCursorConfigPath = agents.cursor.configPath;
const realCursorMcp = join(homedir(), ".cursor", "mcp.json");

const scratch = (): string => {
	const cwd = mkdtempSync(join(tmpdir(), "neon-scope-telem-"));
	dirs.push(cwd);
	return cwd;
};

const fakeNpx = (prefix: string): { bin: string; argvFile: string } => {
	const bin = mkdtempSync(join(tmpdir(), `neon-${prefix}-bin-`));
	dirs.push(bin);
	const argvFile = join(bin, "argv.json");
	writeFileSync(
		join(bin, "npx"),
		`#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const argvFile = process.env.${prefix.toUpperCase()}_ARGV_FILE;
let all = [];
try {
  const parsed = JSON.parse(readFileSync(argvFile, "utf8"));
  all = Array.isArray(parsed) && parsed.every((item) => Array.isArray(item))
    ? parsed
    : [parsed];
} catch {}
all.push(process.argv.slice(2));
writeFileSync(argvFile, JSON.stringify(all));
if (process.env.${prefix.toUpperCase()}_CHILD_EXIT) {
  process.exit(Number(process.env.${prefix.toUpperCase()}_CHILD_EXIT));
}
`,
	);
	chmodSync(join(bin, "npx"), 0o755);
	return { bin, argvFile };
};

const baseProps = (cwd: string) => ({
	apiClient: {} as never,
	apiKey: "test-key",
	apiHost: "https://console.neon.tech/api/v2",
	output: "json" as const,
	contextFile: join(cwd, ".neon"),
});

const isArgvLog = (value: unknown): value is string[][] =>
	Array.isArray(value) &&
	value.every(
		(row) =>
			Array.isArray(row) && row.every((part) => typeof part === "string"),
	);

const spawned = (argvFile: string): string[][] => {
	const parsed: unknown = JSON.parse(readFileSync(argvFile, "utf8"));
	if (!isArgvLog(parsed)) {
		throw new Error(`invalid argv log at ${argvFile}`);
	}
	return parsed;
};

beforeEach(() => {
	takeCommandSuccessExtras();
	vi.stubEnv("CI", "true");
	vi.spyOn(process.stdout, "write").mockReturnValue(true);
	vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
	process.chdir(previousCwd);
	process.env.PATH = previousPath;
	agents.cursor.configPath = originalCursorConfigPath;
	takeCommandSuccessExtras();
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("install scope telemetry", () => {
	test("plugins -y records project scope after the plugins CLI is invoked at project scope", async () => {
		const cwd = scratch();
		const { bin, argvFile } = fakeNpx("plugins");
		vi.stubEnv("PLUGINS_ARGV_FILE", argvFile);
		process.env.PATH = `${bin}:${previousPath}`;
		process.chdir(cwd);
		await pluginsHandler({
			...baseProps(cwd),
			yes: true,
			agent: ["cursor"],
		});
		expect(spawned(argvFile)[0]).toEqual(
			expect.arrayContaining(["-s", "project"]),
		);
		expect(takeCommandSuccessExtras()).toEqual({ scope: "project" });
	});

	test("plugins --global records global scope after the plugins CLI is invoked at user scope", async () => {
		const cwd = scratch();
		const { bin, argvFile } = fakeNpx("plugins");
		vi.stubEnv("PLUGINS_ARGV_FILE", argvFile);
		process.env.PATH = `${bin}:${previousPath}`;
		process.chdir(cwd);
		await pluginsHandler({
			...baseProps(cwd),
			yes: true,
			global: true,
			agent: ["cursor"],
		});
		expect(spawned(argvFile)[0]).toEqual(
			expect.arrayContaining(["-s", "user"]),
		);
		expect(takeCommandSuccessExtras()).toEqual({ scope: "global" });
	});

	test("plugins does not record scope when the plugins CLI fails", async () => {
		const cwd = scratch();
		const { bin, argvFile } = fakeNpx("plugins");
		vi.stubEnv("PLUGINS_ARGV_FILE", argvFile);
		vi.stubEnv("PLUGINS_CHILD_EXIT", "1");
		process.env.PATH = `${bin}:${previousPath}`;
		process.chdir(cwd);
		await expect(
			pluginsHandler({
				...baseProps(cwd),
				yes: true,
				agent: ["cursor"],
			}),
		).rejects.toThrow(/plugins CLI failed|Retry with/);
		expect(spawned(argvFile)).toHaveLength(1);
		expect(takeCommandSuccessExtras()).toEqual({});
	});

	test("skills -y records project scope after the skills CLI is invoked without -g", async () => {
		const cwd = scratch();
		const { bin, argvFile } = fakeNpx("skills");
		vi.stubEnv("SKILLS_ARGV_FILE", argvFile);
		process.env.PATH = `${bin}:${previousPath}`;
		process.chdir(cwd);
		await skillsHandler({
			...baseProps(cwd),
			yes: true,
			agent: ["cursor"],
			skill: ["neon"],
		});
		const args = spawned(argvFile)[0];
		expect(args).toBeDefined();
		expect(args?.includes("-g")).toBe(false);
		expect(takeCommandSuccessExtras()).toEqual({ scope: "project" });
	});

	test("skills --global records global scope after the skills CLI is invoked with -g", async () => {
		const cwd = scratch();
		const { bin, argvFile } = fakeNpx("skills");
		vi.stubEnv("SKILLS_ARGV_FILE", argvFile);
		process.env.PATH = `${bin}:${previousPath}`;
		process.chdir(cwd);
		await skillsHandler({
			...baseProps(cwd),
			yes: true,
			global: true,
			agent: ["cursor"],
			skill: ["neon"],
		});
		expect(spawned(argvFile)[0]).toEqual(expect.arrayContaining(["-g"]));
		expect(takeCommandSuccessExtras()).toEqual({ scope: "global" });
	});

	test("mcp --project records project scope after writing the project Cursor config", async () => {
		const cwd = scratch();
		mkdirSync(join(cwd, ".cursor"));
		process.chdir(cwd);
		await mcpHandler({
			...baseProps(cwd),
			yes: true,
			oauth: true,
			project: true,
			agent: ["cursor"],
		});
		expect(
			JSON.parse(readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8")),
		).toMatchObject({ mcpServers: { Neon: { url: NEON_MCP_URL } } });
		expect(takeCommandSuccessExtras()).toEqual({ scope: "project" });
	});

	test("mcp -y records global scope after writing the redirected Cursor config", async () => {
		const cwd = scratch();
		const home = scratch();
		mkdirSync(join(home, ".cursor"));
		// add-mcp snapshots os.homedir() at import, so HOME cannot redirect this write.
		agents.cursor.configPath = join(home, ".cursor", "mcp.json");
		const beforeReal = existsSync(realCursorMcp)
			? statSync(realCursorMcp).mtimeMs
			: undefined;
		process.chdir(cwd);
		await mcpHandler({
			...baseProps(cwd),
			yes: true,
			oauth: true,
			agent: ["cursor"],
		});
		expect(
			JSON.parse(readFileSync(agents.cursor.configPath, "utf8")),
		).toMatchObject({ mcpServers: { Neon: { url: NEON_MCP_URL } } });
		expect(
			existsSync(realCursorMcp)
				? statSync(realCursorMcp).mtimeMs
				: undefined,
		).toBe(beforeReal);
		expect(takeCommandSuccessExtras()).toEqual({ scope: "global" });
	});
});
