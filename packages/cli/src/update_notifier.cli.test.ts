/**
 * The duplicate-install warning as the built CLI prints it. A PTY is required because the
 * notifier only runs when stdout and stderr are terminals.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawn } from "node-pty";
import strip from "strip-ansi";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

const CLI = join(process.cwd(), "dist/cli.js");
const HOMEBREW =
	"brew/Cellar/neonctl/6.3.0/libexec/lib/node_modules/neonctl/bin/cli.js";
const NPM = "npm/lib/node_modules/neon/dist/cli.js";

const roots: string[] = [];
afterEach(() => {
	while (roots.length > 0) {
		rmSync(roots.pop() ?? "", { force: true, recursive: true });
	}
});

beforeAll(() => {
	const spawnHelper = join(
		process.cwd(),
		"node_modules",
		"node-pty",
		"prebuilds",
		`${process.platform}-${process.arch}`,
		"spawn-helper",
	);
	if (existsSync(spawnHelper)) chmodSync(spawnHelper, 0o755);
});

const scratch = (): string => {
	const root = mkdtempSync(join(tmpdir(), "neon-dup-cli-"));
	roots.push(root);
	return root;
};

/** Homebrew links `neon` and `neonctl`; the npm `neon` package links only `neon`. */
const install = (root: string, target: string, bin: string): string => {
	const file = join(root, target);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
	const binDir = join(root, bin);
	mkdirSync(binDir, { recursive: true });
	const names = target === HOMEBREW ? ["neon", "neonctl"] : ["neon"];
	for (const name of names) symlinkSync(file, join(binDir, name));
	return binDir;
};

type Run = { code: number; output: string };

const run = (root: string, path: string[], args: string[] = []): Promise<Run> =>
	new Promise((resolve) => {
		const configDir = join(root, "config");
		mkdirSync(configDir, { recursive: true });
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
				CLI,
				"profile",
				"list",
				"--config-dir",
				configDir,
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

	test("warns on every run", async () => {
		const root = scratch();
		const path = [
			install(root, NPM, "npm/bin"),
			install(root, HOMEBREW, "brew/bin"),
		];

		for (let attempt = 0; attempt < 2; attempt++) {
			const { output } = await run(root, path);
			expect(output).toContain("(npm, first on PATH)");
			expect(output).toContain("brew uninstall neonctl");
		}
	}, 20_000);

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

		const { code, output } = await run(root, path, ["--output", "json"]);

		expect(code).toBe(0);
		expect(output).not.toContain("Multiple Neon CLI installs");
		expect(() => JSON.parse(output)).not.toThrow();
	}, 20_000);
});
