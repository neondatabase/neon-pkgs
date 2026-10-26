import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { npmEnvForIsolatedHome } from "../src/test_utils/npm_env.js";
import { runCli } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

/** A HOME, config directory, and project directory nothing else has touched. */
const machine = () => {
	const root = mkdtempSync(join(tmpdir(), "neon-skills-e2e-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const dirs = {
		home: join(root, "home"),
		config: join(root, "config"),
		app: join(root, "app"),
	};
	for (const dir of Object.values(dirs)) mkdirSync(dir);
	const env = {
		...npmEnvForIsolatedHome(),
		HOME: dirs.home,
		XDG_STATE_HOME: undefined,
		NO_UPDATE_NOTIFIER: undefined,
		CI: "",
	};
	const neon = (args: string[], json = true) =>
		runCli(args, {
			apiKey: null,
			configDir: dirs.config,
			cwd: dirs.app,
			env,
			json,
		});
	return { ...dirs, neon };
};

type Row = { scope: string; skill: string; status: string };

const statusOf = async (
	neon: ReturnType<typeof machine>["neon"],
	args: string[],
): Promise<Row[]> => {
	const result = await neon(["skills", "status", ...args]);
	expect(result.code, result.stderr).toBe(0);
	return JSON.parse(result.stdout);
};

const rewriteLock = (
	path: string,
	skill: string,
	field: "computedHash" | "skillFolderHash",
) => {
	const lock = JSON.parse(readFileSync(path, "utf8"));
	lock.skills[skill][field] = "0".repeat(40);
	writeFileSync(path, JSON.stringify(lock));
};

describe("neon skills status", () => {
	it("matches a fresh project install, then flags it once the lock falls behind", async () => {
		const { app, neon } = machine();
		const install = await neon(
			["skills", "-y", "-s", "neon", "--agent", "cursor"],
			false,
		);
		expect(install.code, install.stderr).toBe(0);

		expect(await statusOf(neon, [])).toEqual([
			{ scope: "this directory", skill: "neon", status: "up to date" },
		]);

		rewriteLock(join(app, "skills-lock.json"), "neon", "computedHash");
		expect(await statusOf(neon, [])).toEqual([
			{ scope: "this directory", skill: "neon", status: "outdated" },
		]);
	});

	it("matches a fresh user-level install, then flags it once the lock falls behind", async () => {
		const { home, neon } = machine();
		const install = await neon(
			["skills", "--global", "-y", "-s", "neon", "--agent", "cursor"],
			false,
		);
		expect(install.code, install.stderr).toBe(0);

		expect(await statusOf(neon, ["--global"])).toEqual([
			{ scope: "user-level", skill: "neon", status: "up to date" },
		]);

		rewriteLock(
			join(home, ".agents", ".skill-lock.json"),
			"neon",
			"skillFolderHash",
		);
		expect(await statusOf(neon, ["--global"])).toEqual([
			{ scope: "user-level", skill: "neon", status: "outdated" },
		]);
	});

	it("reports an empty lock without contacting GitHub", async () => {
		const { neon } = machine();
		expect(await statusOf(neon, [])).toEqual([]);
	});
});

describe("outdated skills notice", () => {
	it("checks in the background, then warns on the next command", async () => {
		const { app, config, neon } = machine();
		const install = await neon(
			["skills", "-y", "-s", "neon", "--agent", "cursor"],
			false,
		);
		expect(install.code, install.stderr).toBe(0);
		rewriteLock(join(app, "skills-lock.json"), "neon", "computedHash");

		const first = await neon(["profile", "list"], false);
		expect(first.code, first.stderr).toBe(0);
		expect(first.stderr).not.toContain("Neon agent skills");

		const cachePath = join(config, "skills-check.json");
		const key = "neondatabase/agent-skills:skills/neon";
		for (let i = 0; i < 60; i += 1) {
			if (
				existsSync(cachePath) &&
				JSON.parse(readFileSync(cachePath, "utf8")).folders[key]
					?.content
			) {
				break;
			}
			await sleep(500);
		}
		expect(
			JSON.parse(readFileSync(cachePath, "utf8")).folders[key],
		).toMatchObject({
			tree: expect.stringMatching(/^[0-9a-f]{40}$/),
			content: expect.stringMatching(/^[0-9a-f]{64}$/),
		});

		const second = await neon(["profile", "list"], false);
		expect(second.stderr).toContain(
			[
				"WARNING: Neon agent skills have updates:",
				"  this directory: neon",
				"Update them:",
				"  neon skills update -y",
			].join("\n"),
		);
	});
});
