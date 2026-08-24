import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
	existingNeonApiKey,
	installNeonMcpServer,
	NEON_MCP_URL,
} from "./install.js";

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
		expect(written.mcpServers.Neon.headers).toBeUndefined();
	});

	test("writes an API-key header, restricts the file, and gitignores it", () => {
		const cwd = tmpProject();
		const result = installNeonMcpServer({
			agent: "cursor",
			scope: "project",
			cwd,
			auth: { kind: "api-key", apiKey: "napi_test_secret" },
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const written = JSON.parse(readFileSync(result.path, "utf8"));
		expect(written.mcpServers.Neon).toMatchObject({
			url: NEON_MCP_URL,
			headers: { Authorization: "Bearer napi_test_secret" },
		});
		expect(statSync(result.path).mode & 0o777).toBe(0o600);
		expect(readFileSync(join(cwd, ".cursor", ".gitignore"), "utf8")).toBe(
			"mcp.json\n",
		);
	});

	test("replaces a key-backed entry when installing with OAuth", () => {
		const cwd = tmpProject();
		installNeonMcpServer({
			agent: "cursor",
			scope: "project",
			cwd,
			auth: { kind: "api-key", apiKey: "napi_test_secret" },
		});
		const result = installNeonMcpServer({
			agent: "cursor",
			scope: "project",
			cwd,
			auth: { kind: "oauth" },
		});

		expect(result.ok).toBe(true);
		const written = JSON.parse(
			readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.Neon.headers).toBeUndefined();
		expect(written.mcpServers.Neon.url).toBe(NEON_MCP_URL);
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

describe("existingNeonApiKey", () => {
	test("reads a Bearer token from a project Cursor config", () => {
		const cwd = tmpProject();
		mkdirSync(join(cwd, ".cursor"), { recursive: true });
		writeFileSync(
			join(cwd, ".cursor", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					Neon: {
						url: NEON_MCP_URL,
						headers: { Authorization: "Bearer napi_existing" },
					},
				},
			}),
		);

		expect(
			existingNeonApiKey({
				agents: ["cursor"],
				scope: "project",
				cwd,
			}),
		).toBe("napi_existing");
	});

	test("does not reuse a Bearer from another server in the same file", () => {
		const cwd = tmpProject();
		mkdirSync(join(cwd, ".cursor"), { recursive: true });
		writeFileSync(
			join(cwd, ".cursor", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					other: {
						url: "https://example.com/mcp",
						headers: { Authorization: "Bearer napi_other" },
					},
					Neon: { url: "https://example.com/mcp" },
				},
			}),
		);

		expect(
			existingNeonApiKey({
				agents: ["cursor"],
				scope: "project",
				cwd,
			}),
		).toBeUndefined();
	});

	test("does not scan a TOML file outside the Neon block", () => {
		const cwd = tmpProject();
		mkdirSync(join(cwd, ".grok"), { recursive: true });
		writeFileSync(
			join(cwd, ".grok", "config.toml"),
			`[mcp_servers.other]
url = "https://example.com/mcp"
http_headers = { Authorization = "Bearer napi_other" }
`,
		);

		expect(
			existingNeonApiKey({
				agents: ["grok-build"],
				scope: "project",
				cwd,
			}),
		).toBeUndefined();
	});

	test("does not reuse a TOML Bearer when the Neon url is not mcp.neon.tech", () => {
		const cwd = tmpProject();
		mkdirSync(join(cwd, ".grok"), { recursive: true });
		writeFileSync(
			join(cwd, ".grok", "config.toml"),
			`[mcp_servers.Neon]
url = "https://example.com/mcp"
notes = "${NEON_MCP_URL}"
http_headers = { Authorization = "Bearer napi_wrong" }
`,
		);

		expect(
			existingNeonApiKey({
				agents: ["grok-build"],
				scope: "project",
				cwd,
			}),
		).toBeUndefined();
	});

	test("reuses a Bearer from a Neon TOML block that points at mcp.neon.tech", () => {
		const cwd = tmpProject();
		mkdirSync(join(cwd, ".grok"), { recursive: true });
		writeFileSync(
			join(cwd, ".grok", "config.toml"),
			`[mcp_servers.Neon]
url = "${NEON_MCP_URL}"
http_headers = { Authorization = "Bearer napi_toml" }
`,
		);

		expect(
			existingNeonApiKey({
				agents: ["grok-build"],
				scope: "project",
				cwd,
			}),
		).toBe("napi_toml");
	});

	test("reuses a Bearer from a project Copilot CLI servers key", () => {
		const cwd = tmpProject();
		mkdirSync(join(cwd, ".vscode"), { recursive: true });
		writeFileSync(
			join(cwd, ".vscode", "mcp.json"),
			JSON.stringify({
				servers: {
					Neon: {
						url: NEON_MCP_URL,
						headers: { Authorization: "Bearer napi_copilot" },
					},
				},
			}),
		);
		expect(
			existingNeonApiKey({
				agents: ["github-copilot-cli"],
				scope: "project",
				cwd,
			}),
		).toBe("napi_copilot");
	});

	test("skips a config path that is a directory", () => {
		const cwd = tmpProject();
		mkdirSync(join(cwd, ".cursor", "mcp.json"), { recursive: true });
		expect(
			existingNeonApiKey({
				agents: ["cursor"],
				scope: "project",
				cwd,
			}),
		).toBeUndefined();
	});
});

describe("installNeonMcpServer write failures", () => {
	test("fails when the config path is a directory", () => {
		const cwd = tmpProject();
		mkdirSync(join(cwd, ".cursor", "mcp.json"), { recursive: true });
		chmodSync(join(cwd, ".cursor"), 0o555);

		const result = installNeonMcpServer({
			agent: "cursor",
			scope: "project",
			cwd,
			auth: { kind: "api-key", apiKey: "napi_test_secret" },
		});

		chmodSync(join(cwd, ".cursor"), 0o755);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.unsupported).toBe(false);
	});

	test("fails when the project gitignore cannot be updated", () => {
		const cwd = tmpProject();
		mkdirSync(join(cwd, ".cursor"), { recursive: true });
		writeFileSync(join(cwd, ".cursor", ".gitignore"), "other\n");
		chmodSync(join(cwd, ".cursor", ".gitignore"), 0o444);

		const result = installNeonMcpServer({
			agent: "cursor",
			scope: "project",
			cwd,
			auth: { kind: "api-key", apiKey: "napi_test_secret" },
		});

		chmodSync(join(cwd, ".cursor", ".gitignore"), 0o644);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.unsupported).toBe(false);
		expect(result.error).toMatch(/gitignore/i);
	});
});
