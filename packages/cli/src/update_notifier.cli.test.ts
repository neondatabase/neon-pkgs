/**
 * Terminal notices as the built CLI prints them. A PTY is required because the notifier only
 * runs when stdout and stderr are terminals.
 */

import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawn } from "node-pty";
import strip from "strip-ansi";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

const PACKAGE = process.cwd();
const CLI = join(PACKAGE, "dist/cli.js");
const HOMEBREW =
	"brew/Cellar/neonctl/6.3.0/libexec/lib/node_modules/neonctl/bin/cli.js";
const NPM = "npm/lib/node_modules/neon/dist/cli.js";
const DAY = 24 * 60 * 60 * 1000;

const roots: string[] = [];
afterEach(() => {
	while (roots.length > 0) {
		rmSync(roots.pop() ?? "", { force: true, recursive: true });
	}
});

/**
 * A copy of the build laid out like a Homebrew install, so the running CLI recognizes its
 * installer and the version notice runs. Its dependencies resolve through a link to this
 * package's `node_modules`.
 */
let brewCellar = "";
let brewCli = "";
beforeAll(() => {
	const spawnHelper = join(
		PACKAGE,
		"node_modules",
		"node-pty",
		"prebuilds",
		`${process.platform}-${process.arch}`,
		"spawn-helper",
	);
	if (existsSync(spawnHelper)) chmodSync(spawnHelper, 0o755);

	brewCellar = mkdtempSync(join(tmpdir(), "neon-brew-copy-"));
	const neon = join(
		brewCellar,
		"Cellar/neonctl/1.0.0/libexec/lib/node_modules/neon",
	);
	mkdirSync(neon, { recursive: true });
	cpSync(join(PACKAGE, "dist"), join(neon, "dist"), { recursive: true });
	writeFileSync(
		join(neon, "package.json"),
		JSON.stringify({
			...JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")),
			version: "1.0.0",
		}),
	);
	symlinkSync(join(PACKAGE, "node_modules"), join(neon, "node_modules"));
	brewCli = join(neon, "dist/cli.js");
	chmodSync(brewCli, 0o755);
});
afterAll(() => {
	rmSync(brewCellar, { force: true, recursive: true });
});

const scratch = (): string => {
	const root = mkdtempSync(join(tmpdir(), "neon-dup-cli-"));
	roots.push(root);
	mkdirSync(join(root, "config"));
	return root;
};

/** Homebrew links `neon` and `neonctl`; the npm `neon` package links only `neon`. */
const install = (root: string, target: string, bin: string): string => {
	const file = join(root, target);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
	return link(root, file, bin, target === HOMEBREW);
};

const link = (
	root: string,
	file: string,
	bin: string,
	withNeonctl: boolean,
): string => {
	const binDir = join(root, bin);
	mkdirSync(binDir, { recursive: true });
	for (const name of withNeonctl ? ["neon", "neonctl"] : ["neon"]) {
		symlinkSync(file, join(binDir, name));
	}
	return binDir;
};

const readJson = (root: string, file: string): unknown =>
	JSON.parse(readFileSync(join(root, "config", file), "utf8"));
const writeJson = (root: string, file: string, value: unknown): void =>
	writeFileSync(join(root, "config", file), JSON.stringify(value));

type Run = { code: number; output: string };

const run = (
	root: string,
	path: string[],
	{ args = [], cli = CLI }: { args?: string[]; cli?: string } = {},
): Promise<Run> =>
	new Promise((resolve) => {
		const env = Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) =>
					key !== "NO_UPDATE_NOTIFIER" &&
					key !== "NEON_API_KEY" &&
					key !== "XDG_CONFIG_HOME",
			),
		);
		const term = spawn(
			process.execPath,
			[
				cli,
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
				cols: 200,
				rows: 40,
				cwd: root,
				env: { ...env, CI: "", HOME: root, PATH: path.join(delimiter) },
				name: "xterm-256color",
			},
		);
		let output = "";
		term.onData((chunk) => {
			output += chunk;
		});
		term.onExit(({ exitCode }) => {
			resolve({
				code: exitCode,
				output: strip(output).replace(/\r/g, ""),
			});
		});
	});

describe("duplicate Neon CLI installs", () => {
	test("warns after the command's output when Homebrew shadows npm", async () => {
		const root = scratch();
		const brew = install(root, HOMEBREW, "brew/bin");
		const npm = install(root, NPM, "npm/bin");

		const { code, output } = await run(root, [brew, npm]);

		expect(code).toBe(0);
		expect(output).toMatch(/Profiles[\s\S]*DEFAULT/);
		expect(output).toContain(
			[
				"WARNING: Multiple Neon CLI installs found on PATH:",
				`  ${join(brew, "neon")} (Homebrew, first on PATH)`,
				`  ${join(npm, "neon")} (npm)`,
				"Remove the Homebrew install to use npm:",
				"  brew uninstall neonctl",
				"This also removes the `neonctl` command; run `neon` instead.",
				"Then open a new shell.",
			].join("\n"),
		);
		expect(output.indexOf("DEFAULT")).toBeLessThan(
			output.indexOf("Multiple Neon CLI installs"),
		);
	}, 20_000);

	test("warns once a day", async () => {
		const root = scratch();
		const path = [
			install(root, NPM, "npm/bin"),
			install(root, HOMEBREW, "brew/bin"),
		];

		const first = await run(root, path);
		expect(first.output).toContain("(npm, first on PATH)");
		expect(first.output).toContain("brew uninstall neonctl");

		const second = await run(root, path);
		expect(second.code).toBe(0);
		expect(second.output).toContain("DEFAULT");
		expect(second.output).not.toContain("WARNING");

		writeJson(root, "notices.json", {
			"duplicate-installs": Date.now() - DAY,
		});
		expect((await run(root, path)).output).toContain(
			"Multiple Neon CLI installs found on PATH:",
		);
	}, 30_000);

	test("stays quiet with one install", async () => {
		const root = scratch();
		const { code, output } = await run(root, [
			install(root, NPM, "npm/bin"),
		]);

		expect(code).toBe(0);
		expect(output).toContain("DEFAULT");
		expect(output).not.toContain("WARNING");
	}, 20_000);

	test("keeps JSON output clean", async () => {
		const root = scratch();
		const path = [
			install(root, HOMEBREW, "brew/bin"),
			install(root, NPM, "npm/bin"),
		];

		const { code, output } = await run(root, path, {
			args: ["--output", "json"],
		});

		expect(code).toBe(0);
		expect(output).not.toContain("Multiple Neon CLI installs");
		expect(() => JSON.parse(output)).not.toThrow();
	}, 20_000);

	test("holds back the update notice while duplicates exist, even on quiet days", async () => {
		const root = scratch();
		const brew = link(root, brewCli, "brew/bin", true);
		const npm = install(root, NPM, "npm/bin");
		const now = Date.now();
		const cache = {
			checkedAt: now,
			latestVersion: "99.0.0",
			source: "homebrew",
		};
		writeJson(root, "update-check.json", cache);
		writeJson(root, "notices.json", { "duplicate-installs": now });

		const quiet = await run(root, [brew, npm], { cli: brewCli });
		expect(quiet.code).toBe(0);
		expect(quiet.output).toContain("DEFAULT");
		expect(quiet.output).not.toContain("WARNING");
		expect(readJson(root, "update-check.json")).toEqual(cache);

		const alone = await run(root, [brew], { cli: brewCli });
		expect(alone.output).toContain(
			"WARNING: Neon CLI update available: 1.0.0 → 99.0.0\nbrew upgrade neonctl",
		);
		expect(readJson(root, "notices.json")).toEqual({
			"duplicate-installs": now,
			update: expect.any(Number),
		});

		const again = await run(root, [brew], { cli: brewCli });
		expect(again.output).not.toContain("WARNING");
	}, 30_000);
});
