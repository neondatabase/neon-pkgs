import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
	detectInstallablePluginsAgents,
	detectPluginsAgents,
	mappedPluginsTargets,
	type PluginsCommandProblem,
	pluginsCommandProblemText,
	pluginsInstallableAgents,
	pluginsMappedAgents,
	type UnusablePluginsCommand,
	unusablePluginsCommands,
} from "./targets.js";

describe("pluginsMappedAgents", () => {
	test("is the MCP roster minus agents with no plugins mapping", () => {
		const ids = pluginsMappedAgents();
		expect(ids).toContain("cursor");
		expect(ids).toContain("claude-desktop");
		expect(ids).toContain("vscode");
		expect(ids).toContain("github-copilot-cli");
		expect(ids).toContain("grok-build");
		expect(ids).not.toContain("mcporter");
		expect(ids).not.toContain("eve");
		expect(ids).not.toContain("cursor-cli");
		expect(ids).not.toContain("kimi");
	});
});

describe("pluginsInstallableAgents", () => {
	test("project scope drops agents the plugins CLI only installs user-level", () => {
		const ids = pluginsInstallableAgents("project");
		expect(ids).toContain("cursor");
		expect(ids).toContain("claude-code");
		expect(ids).not.toContain("vscode");
		expect(ids).not.toContain("github-copilot-cli");
		expect(ids).not.toContain("grok-build");
		expect(ids).not.toContain("mcporter");
	});

	test("user-level includes vscode, Copilot CLI, and Grok", () => {
		const ids = pluginsInstallableAgents("global");
		expect(ids).toContain("vscode");
		expect(ids).toContain("github-copilot-cli");
		expect(ids).toContain("grok-build");
		expect(ids).toContain("cursor");
	});
});

describe("mappedPluginsTargets", () => {
	test("dedupes Claude Desktop and Claude Code onto claude-code", () => {
		expect(
			mappedPluginsTargets(
				["claude-desktop", "claude-code", "cursor"],
				"project",
			),
		).toEqual([
			{
				agents: ["claude-desktop", "claude-code"],
				target: "claude-code",
			},
			{ agents: ["cursor"], target: "cursor" },
		]);
	});

	test("maps vscode to vscode, not github-copilot", () => {
		expect(mappedPluginsTargets(["vscode"], "global")).toEqual([
			{ agents: ["vscode"], target: "vscode" },
		]);
		expect(mappedPluginsTargets(["github-copilot-cli"], "global")).toEqual([
			{ agents: ["github-copilot-cli"], target: "github-copilot" },
		]);
	});

	test("throws when every selected agent lacks a mapping", () => {
		expect(() => mappedPluginsTargets(["mcporter"], "project")).toThrow(
			/None of the selected agents can install plugins/,
		);
	});
});

describe("unusablePluginsCommands", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
		vi.unstubAllEnvs();
	});

	const tmp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "neon-plugins-commands-"));
		dirs.push(dir);
		return dir;
	};

	const installCommand = (dir: string, name: string, body: string): void => {
		mkdirSync(dir, { recursive: true });
		const file = join(dir, name);
		writeFileSync(file, `#!/bin/sh\n${body}\n`);
		chmodSync(file, 0o755);
	};

	const COPILOT = {
		name: "copilot",
		product: "GitHub Copilot CLI",
		minVersion: "0.0.400",
	};
	const GROK = { name: "grok" };

	test("reports copilot and grok when neither is on PATH", () => {
		const root = tmp();
		const emptyBin = join(root, "bin");
		mkdirSync(emptyBin);
		expect(
			unusablePluginsCommands(
				[
					"cursor",
					"codex",
					"claude-code",
					"github-copilot-cli",
					"grok-build",
					"github-copilot-cli",
				],
				{ cwd: root, path: emptyBin },
			),
		).toEqual([
			{
				agent: "github-copilot-cli",
				command: COPILOT,
				problem: { kind: "missing" },
			},
			{
				agent: "grok-build",
				command: GROK,
				problem: { kind: "missing" },
			},
		]);
	});

	test.each([
		"GitHub Copilot CLI 1.0.104-1.",
		"GitHub Copilot CLI 1.0.102-0.unstable.r40029025960.g5a14a15.",
		"GitHub Copilot CLI 0.0.400.",
	])("accepts %s", (version) => {
		const root = tmp();
		const bin = join(root, "bin");
		installCommand(bin, "copilot", `echo "${version}"`);
		installCommand(bin, "grok", "echo 'grok 0.1.42 [stable]'");
		expect(
			unusablePluginsCommands(["github-copilot-cli", "grok-build"], {
				cwd: root,
				path: bin,
			}),
		).toEqual([]);
	});

	test.each([
		[
			"a Copilot CLI older than 0.0.400",
			'echo "GitHub Copilot CLI 0.0.399."',
			{ kind: "outdated", version: "0.0.399" },
		],
		[
			"the VS Code launcher without the real CLI",
			'echo "GitHub Copilot CLI was not found. Run copilot in a terminal to install it." >&2; exit 1',
			{
				kind: "broken",
				detail: "GitHub Copilot CLI was not found. Run copilot in a terminal to install it",
			},
		],
		[
			"a command that prints no Copilot version",
			"echo 'Cannot find GitHub Copilot CLI'",
			{ kind: "unrecognized" },
		],
		[
			"a command that fails silently",
			"exit 3",
			{ kind: "broken", detail: "exit code 3" },
		],
	])("reports %s", (_label, body, problem) => {
		const root = tmp();
		const bin = join(root, "bin");
		installCommand(bin, "copilot", body);
		expect(
			unusablePluginsCommands(["github-copilot-cli"], {
				cwd: root,
				path: bin,
			}),
		).toEqual([{ agent: "github-copilot-cli", command: COPILOT, problem }]);
	});

	test("reports a grok whose --version fails", () => {
		const root = tmp();
		const bin = join(root, "bin");
		installCommand(bin, "grok", "echo 'error: unknown flag' >&2; exit 2");
		expect(
			unusablePluginsCommands(["grok-build"], { cwd: root, path: bin }),
		).toEqual([
			{
				agent: "grok-build",
				command: GROK,
				problem: { kind: "broken", detail: "error: unknown flag" },
			},
		]);
	});

	test("finds a command in node_modules/.bin above cwd, like npx", () => {
		const root = tmp();
		installCommand(join(root, "node_modules", ".bin"), "grok", "exit 0");
		const nested = join(root, "apps", "web");
		mkdirSync(nested, { recursive: true });
		expect(
			unusablePluginsCommands(["grok-build"], { cwd: nested, path: "" }),
		).toEqual([]);
	});

	test("probes without the Neon API key, like the plugins CLI", () => {
		vi.stubEnv("NEON_API_KEY", "napi_test");
		const root = tmp();
		const bin = join(root, "bin");
		installCommand(
			bin,
			"copilot",
			'[ -n "$NEON_API_KEY" ] && exit 1; echo "GitHub Copilot CLI 1.0.104."',
		);
		expect(
			unusablePluginsCommands(["github-copilot-cli"], {
				cwd: root,
				path: bin,
			}),
		).toEqual([]);
	});

	test("does not run anything for file-based targets", () => {
		const root = tmp();
		const bin = join(root, "bin");
		const marker = join(root, "ran");
		for (const name of ["claude", "cursor", "codex", "code"]) {
			installCommand(bin, name, `touch "${marker}"`);
		}
		expect(
			unusablePluginsCommands(
				["claude-code", "cursor", "codex", "vscode"],
				{
					cwd: root,
					path: bin,
				},
			),
		).toEqual([]);
		expect(existsSync(marker)).toBe(false);
	});
});

describe("pluginsCommandProblemText", () => {
	const row = (problem: PluginsCommandProblem): UnusablePluginsCommand => ({
		agent: "github-copilot-cli",
		command: {
			name: "copilot",
			product: "GitHub Copilot CLI",
			minVersion: "0.0.400",
		},
		problem,
	});

	test.each([
		[{ kind: "missing" } as const, "was not found on PATH"],
		[
			{ kind: "broken", detail: "exit code 3" } as const,
			'did not run ("copilot --version" failed: exit code 3)',
		],
		[
			{ kind: "unrecognized" } as const,
			'is not GitHub Copilot CLI ("copilot --version" printed no GitHub Copilot CLI version)',
		],
		[
			{ kind: "outdated", version: "0.0.399" } as const,
			"is GitHub Copilot CLI 0.0.399, older than the 0.0.400 its plugin needs",
		],
	])("describes %o", (problem, text) => {
		expect(pluginsCommandProblemText(row(problem))).toBe(text);
	});
});

describe("detectPluginsAgents", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("project scope detects from the project folder", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-plugins-detect-"));
		dirs.push(cwd);
		mkdirSync(join(cwd, ".cursor"));
		expect(await detectPluginsAgents({ scope: "project", cwd })).toContain(
			"cursor",
		);
	});

	test("project scope ignores a folder with no agent markers", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-plugins-detect-empty-"));
		dirs.push(cwd);
		expect(await detectPluginsAgents({ scope: "project", cwd })).toEqual(
			[],
		);
	});

	test("project installable detection drops user-scope-only agents", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-plugins-detect-vscode-"));
		dirs.push(cwd);
		mkdirSync(join(cwd, ".vscode"));
		expect(await detectPluginsAgents({ scope: "project", cwd })).toContain(
			"vscode",
		);
		expect(
			await detectInstallablePluginsAgents({ scope: "project", cwd }),
		).toEqual([]);
	});
});
