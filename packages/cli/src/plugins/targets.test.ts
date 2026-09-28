import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
	detectInstallablePluginsAgents,
	detectPluginsAgents,
	mappedPluginsTargets,
	missingPluginsCommands,
	pluginsInstallableAgents,
	pluginsMappedAgents,
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

describe("missingPluginsCommands", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const tmp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "neon-plugins-commands-"));
		dirs.push(dir);
		return dir;
	};

	const installCommand = (dir: string, name: string): void => {
		mkdirSync(dir, { recursive: true });
		const file = join(dir, name);
		writeFileSync(file, "#!/bin/sh\nexit 0\n");
		chmodSync(file, 0o755);
	};

	test("reports copilot and grok when neither is on PATH", () => {
		const root = tmp();
		const emptyBin = join(root, "bin");
		mkdirSync(emptyBin);
		expect(
			missingPluginsCommands(
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
			{ agent: "github-copilot-cli", command: "copilot" },
			{ agent: "grok-build", command: "grok" },
		]);
	});

	test("finds a command on PATH", () => {
		const root = tmp();
		const bin = join(root, "bin");
		installCommand(bin, "copilot");
		expect(
			missingPluginsCommands(["github-copilot-cli", "grok-build"], {
				cwd: root,
				path: bin,
			}),
		).toEqual([{ agent: "grok-build", command: "grok" }]);
	});

	test("finds a command in node_modules/.bin above cwd, like npx", () => {
		const root = tmp();
		installCommand(join(root, "node_modules", ".bin"), "grok");
		const nested = join(root, "apps", "web");
		mkdirSync(nested, { recursive: true });
		expect(
			missingPluginsCommands(["grok-build"], { cwd: nested, path: "" }),
		).toEqual([]);
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
