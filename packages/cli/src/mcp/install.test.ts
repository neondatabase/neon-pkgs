import { execFileSync } from "node:child_process";
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
	isNeonMcpUrl,
	NEON_MCP_URL,
	neonMcpUrl,
	parseMcpCategories,
	trackedProjectMcpConfig,
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

	test("writes Claude Code's .mcp.json when only .github/mcp.json exists", () => {
		const cwd = tmpProject();
		mkdirSync(join(cwd, ".github"));
		const github =
			'{ "mcpServers": { "other": { "url": "https://example.com/mcp" } } }\n';
		writeFileSync(join(cwd, ".github", "mcp.json"), github);

		const result = installNeonMcpServer({
			agent: "claude-code",
			scope: "project",
			cwd,
		});

		expect(result).toEqual({ ok: true, path: join(cwd, ".mcp.json") });
		const written = JSON.parse(
			readFileSync(join(cwd, ".mcp.json"), "utf8"),
		);
		expect(Object.keys(written.mcpServers)).toEqual(["Neon"]);
		expect(readFileSync(join(cwd, ".github", "mcp.json"), "utf8")).toBe(
			github,
		);
	});

	test("writes GitHub Copilot CLI into an existing .github/mcp.json", () => {
		const cwd = tmpProject();
		mkdirSync(join(cwd, ".github"));
		writeFileSync(
			join(cwd, ".github", "mcp.json"),
			'{ "mcpServers": {} }\n',
		);

		const result = installNeonMcpServer({
			agent: "github-copilot-cli",
			scope: "project",
			cwd,
		});

		expect(result).toEqual({
			ok: true,
			path: join(cwd, ".github", "mcp.json"),
		});
	});

	test("skips fx with an API key", () => {
		const cwd = tmpProject();
		const result = installNeonMcpServer({
			agent: "fx",
			scope: "global",
			cwd,
			auth: { kind: "api-key", apiKey: "napi_test_secret" },
		});

		expect(result).toEqual({
			ok: false,
			unsupported: true,
			error: expect.stringMatching(/mcp --oauth --agent fx/),
		});
	});

	test("writes a custom Neon MCP URL into the config", () => {
		const cwd = tmpProject();
		const url = neonMcpUrl({ readOnly: true, projectId: "proj-1" });
		const result = installNeonMcpServer({
			agent: "cursor",
			scope: "project",
			cwd,
			url,
		});
		expect(result.ok).toBe(true);
		const written = JSON.parse(
			readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.Neon.url).toBe(url);
	});
});

describe("neonMcpUrl", () => {
	test("omits query params by default", () => {
		expect(neonMcpUrl()).toBe(NEON_MCP_URL);
		expect(neonMcpUrl({ readOnly: false, categories: [] })).toBe(
			NEON_MCP_URL,
		);
	});

	test("orders readonly, then categories, then projectId", () => {
		expect(
			neonMcpUrl({
				readOnly: true,
				projectId: "proj-1",
				categories: ["querying", "schema"],
			}),
		).toBe(
			"https://mcp.neon.tech/mcp?readonly=true&category=querying&category=schema&projectId=proj-1",
		);
	});

	test("preserves duplicate categories", () => {
		expect(neonMcpUrl({ categories: ["docs", "docs"] })).toBe(
			"https://mcp.neon.tech/mcp?category=docs&category=docs",
		);
	});
});

describe("parseMcpCategories", () => {
	test("rejects unknown names", () => {
		expect(() => parseMcpCategories(["querying", "nope"])).toThrow(
			/Unknown MCP category: "nope"/,
		);
	});
});

describe("isNeonMcpUrl", () => {
	test("accepts the hosted path with query params", () => {
		expect(isNeonMcpUrl(NEON_MCP_URL)).toBe(true);
		expect(isNeonMcpUrl(`${NEON_MCP_URL}?readonly=true`)).toBe(true);
		expect(isNeonMcpUrl("https://example.com/mcp")).toBe(false);
		expect(isNeonMcpUrl("https://mcp.neon.tech/sse")).toBe(false);
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

	test("reuses a Bearer when the Neon URL already has query params", () => {
		const cwd = tmpProject();
		mkdirSync(join(cwd, ".cursor"), { recursive: true });
		writeFileSync(
			join(cwd, ".cursor", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					Neon: {
						url: neonMcpUrl({ readOnly: true }),
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

	test("reuses a Bearer from a project Copilot CLI .mcp.json", () => {
		const cwd = tmpProject();
		writeFileSync(
			join(cwd, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
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

	test("reuses a Bearer from a bare server map in .github/mcp.json", () => {
		const cwd = tmpProject();
		mkdirSync(join(cwd, ".github"));
		writeFileSync(
			join(cwd, ".github", "mcp.json"),
			JSON.stringify({
				Neon: {
					url: NEON_MCP_URL,
					headers: { Authorization: "Bearer napi_github" },
				},
			}),
		);
		expect(
			existingNeonApiKey({
				agents: ["github-copilot-cli"],
				scope: "project",
				cwd,
			}),
		).toBe("napi_github");
	});

	test("reuses a Bearer from an OpenCode opencode.json server map", () => {
		const cwd = tmpProject();
		writeFileSync(
			join(cwd, "opencode.json"),
			JSON.stringify({
				mcp: {
					servers: {
						Neon: {
							type: "remote",
							url: NEON_MCP_URL,
							headers: { Authorization: "Bearer napi_opencode" },
						},
					},
				},
			}),
		);
		expect(
			existingNeonApiKey({
				agents: ["opencode"],
				scope: "project",
				cwd,
			}),
		).toBe("napi_opencode");
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

describe("trackedProjectMcpConfig", () => {
	test("checks the file add-mcp writes, including .github/mcp.json", () => {
		const cwd = tmpProject();
		mkdirSync(join(cwd, ".github"));
		writeFileSync(join(cwd, ".github", "mcp.json"), "{}\n");
		execFileSync("git", ["-C", cwd, "init"], { stdio: "ignore" });
		execFileSync("git", ["-C", cwd, "add", "--", ".github/mcp.json"], {
			stdio: "ignore",
		});

		expect(
			trackedProjectMcpConfig({ agents: ["github-copilot-cli"], cwd }),
		).toBe(join(".github", "mcp.json"));
	});
});
