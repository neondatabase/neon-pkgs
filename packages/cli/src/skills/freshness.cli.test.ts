/**
 * The skills notice as the built CLI prints it. The cache is seeded with a fresh check, so no
 * run reaches GitHub; `e2e/skills.e2e.test.ts` covers the background refresh.
 */

import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const CLI = join(process.cwd(), "dist/cli.js");
const DAY = 24 * 60 * 60 * 1000;
const SOURCE = "neondatabase/agent-skills";

const roots: string[] = [];
afterEach(() => {
	while (roots.length > 0) {
		rmSync(roots.pop() ?? "", { force: true, recursive: true });
	}
});

const lockEntry = (folder: string, hash: Record<string, string>) => ({
	source: SOURCE,
	sourceType: "github",
	skillPath: `${folder}/SKILL.md`,
	...hash,
});

const hex = (char: string, length: number) => char.repeat(length);

/**
 * One user-level skill behind, one project skill current, one project skill behind. The locks
 * were written an hour before the cached check.
 */
const machine = (): string => {
	const root = mkdtempSync(join(tmpdir(), "neon-skills-notice-"));
	roots.push(root);
	for (const dir of ["config", "home/.agents", "app"]) {
		mkdirSync(join(root, dir), { recursive: true });
	}
	const locks = {
		"home/.agents/.skill-lock.json": {
			version: 3,
			skills: {
				neon: lockEntry("skills/neon", {
					skillFolderHash: hex("a", 40),
				}),
			},
		},
		"app/skills-lock.json": {
			version: 1,
			skills: {
				"neon-auth": lockEntry("skills/neon-auth", {
					computedHash: hex("c", 64),
				}),
				"neon-postgres": lockEntry("skills/neon-postgres", {
					computedHash: hex("d", 64),
				}),
			},
		},
	};
	const installedAt = new Date(Date.now() - 60 * 60 * 1000);
	for (const [path, lock] of Object.entries(locks)) {
		writeFileSync(join(root, path), JSON.stringify(lock));
		utimesSync(join(root, path), installedAt, installedAt);
	}
	writeJson(root, "skills-check.json", {
		checkedAt: Date.now(),
		folders: {
			[`${SOURCE}:skills/neon`]: { tree: hex("b", 40) },
			[`${SOURCE}:skills/neon-auth`]: {
				tree: hex("1", 40),
				content: hex("c", 64),
			},
			[`${SOURCE}:skills/neon-postgres`]: {
				tree: hex("2", 40),
				content: hex("e", 64),
			},
		},
	});
	return root;
};

const readJson = (root: string, file: string): unknown =>
	JSON.parse(readFileSync(join(root, "config", file), "utf8"));
const writeJson = (root: string, file: string, value: unknown): void =>
	writeFileSync(join(root, "config", file), JSON.stringify(value));

const run = (
	root: string,
	args: string[] = [],
	extraEnv: Record<string, string> = {},
) => {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) =>
				key !== "NO_UPDATE_NOTIFIER" &&
				key !== "NEON_API_KEY" &&
				key !== "XDG_CONFIG_HOME" &&
				key !== "XDG_STATE_HOME",
		),
	);
	const result = spawnSync(
		process.execPath,
		[
			CLI,
			"profile",
			"list",
			"--config-dir",
			join(root, "config"),
			"--context-file",
			join(root, ".neon"),
			"--no-analytics",
			...args,
		],
		{
			cwd: join(root, "app"),
			encoding: "utf8",
			env: { ...env, CI: "", HOME: join(root, "home"), ...extraEnv },
		},
	);
	return {
		code: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
};

const NOTICE = [
	"WARNING: Neon agent skills have updates:",
	"  user-level: neon",
	"  this directory: neon-postgres",
	"Update them:",
	"  neon skills update --global -y",
	"  neon skills update -y",
].join("\n");

describe("outdated Neon skills notice", () => {
	test("warns once a day without a terminal", () => {
		const root = machine();

		const first = run(root);
		expect(first.code).toBe(0);
		expect(first.stderr).toContain(NOTICE);

		const second = run(root);
		expect(second.code).toBe(0);
		expect(second.stderr).not.toContain("Neon agent skills");

		writeJson(root, "notices.json", { skills: Date.now() - DAY });
		expect(run(root).stderr).toContain(NOTICE);
	}, 30_000);

	test("keeps JSON output clean", () => {
		const root = machine();
		const { code, stdout, stderr } = run(root, ["--output", "json"]);

		expect(code).toBe(0);
		expect(stderr).not.toContain("Neon agent skills");
		expect(() => JSON.parse(stdout)).not.toThrow();
	}, 20_000);

	test("stays quiet when NO_UPDATE_NOTIFIER is set", () => {
		const root = machine();
		const { code, stderr } = run(root, [], { NO_UPDATE_NOTIFIER: "1" });

		expect(code).toBe(0);
		expect(stderr).not.toContain("Neon agent skills");
		expect(() => readJson(root, "notices.json")).toThrow();
	}, 20_000);

	test("stays quiet in CI", () => {
		const root = machine();
		const { code, stderr } = run(root, [], { CI: "true" });

		expect(code).toBe(0);
		expect(stderr).not.toContain("Neon agent skills");
	}, 20_000);
});
