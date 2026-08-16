import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { installNeonMcpServer, NEON_MCP_URL } from "./install_mcp.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tmpProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "neon-mcp-"));
	dirs.push(dir);
	return dir;
}

describe("installNeonMcpServer", () => {
	test("writes the Neon HTTP server into a project Cursor config", () => {
		const cwd = tmpProject();
		const result = installNeonMcpServer({
			agent: "cursor",
			scope: "project",
			cwd,
		});

		expect(result).toEqual({
			ok: true,
			path: join(cwd, ".cursor", "mcp.json"),
		});

		const written = JSON.parse(
			readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.Neon).toMatchObject({
			url: NEON_MCP_URL,
		});
	});

	test("writes the Neon HTTP server into a project Grok config", () => {
		const cwd = tmpProject();
		const result = installNeonMcpServer({
			agent: "grok-build",
			scope: "project",
			cwd,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.path).toBe(join(cwd, ".grok", "config.toml"));
		expect(readFileSync(result.path, "utf8")).toContain("mcp.neon.tech");
	});

	test("does not write Claude Desktop config for remote HTTP", () => {
		const cwd = tmpProject();
		const result = installNeonMcpServer({
			agent: "claude-desktop",
			scope: "global",
			cwd,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.unsupported).toBe(true);
		expect(result.error).toMatch(/Connectors/i);
	});

	test("does not fall back to global when the agent has no project config", () => {
		const cwd = tmpProject();
		const result = installNeonMcpServer({
			agent: "windsurf",
			scope: "project",
			cwd,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.unsupported).toBe(true);
		expect(result.error).toMatch(/project-level/i);
	});
});
