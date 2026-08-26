import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { detectMcpAgents, resolveInstallTargets } from "./targets.js";

describe("resolveInstallTargets", () => {
	test("dedupes aliases that resolve to the same client", () => {
		const result = resolveInstallTargets({
			agents: ["claude", "claude-code", "cursor"],
			scope: "global",
		});
		expect(result.install).toEqual(["claude-code", "cursor"]);
		expect(result.skipped).toEqual([]);
	});

	test("throws on an unknown agent before any install list is returned", () => {
		expect(() =>
			resolveInstallTargets({
				agents: ["not-an-agent"],
				scope: "global",
			}),
		).toThrow(/Unknown agent: "not-an-agent"/);
	});

	test("throws when every selected agent is unsupported for the scope", () => {
		expect(() =>
			resolveInstallTargets({
				agents: ["claude-desktop"],
				scope: "global",
			}),
		).toThrow(/Connectors/i);
		expect(() =>
			resolveInstallTargets({
				agents: ["windsurf"],
				scope: "project",
			}),
		).toThrow(/project-level/);
	});

	test("skips unsupported agents next to ones that can install", () => {
		const result = resolveInstallTargets({
			agents: ["cursor", "claude-desktop"],
			scope: "global",
		});
		expect(result.install).toEqual(["cursor"]);
		expect(result.skipped.map((row) => row.agent)).toEqual([
			"claude-desktop",
		]);
		expect(result.skipped[0]?.error).toMatch(/Connectors/i);
	});
});

describe("detectMcpAgents", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("project scope detects from the project folder", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-mcp-detect-"));
		dirs.push(cwd);
		mkdirSync(join(cwd, ".cursor"));
		expect(await detectMcpAgents({ scope: "project", cwd })).toContain(
			"cursor",
		);
	});

	test("project scope ignores a folder with no agent markers", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-mcp-detect-empty-"));
		dirs.push(cwd);
		expect(await detectMcpAgents({ scope: "project", cwd })).toEqual([]);
	});
});
