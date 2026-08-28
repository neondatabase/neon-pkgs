import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import strip from "strip-ansi";
import { afterEach, describe, expect } from "vitest";

import {
	NEON_MCP_CATEGORIES,
	NEON_MCP_URL,
	neonMcpUrl,
} from "../mcp/install.js";
import { mcpInstallableAgents } from "../mcp/targets.js";
import { test } from "../test_utils/fixtures";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const SECRET = "napi_account_secret";
const PROJECT_SECRET = "napi_org_secret";

function scratch(): { home: string; cwd: string } {
	const home = mkdtempSync(join(tmpdir(), "neon-mcp-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "neon-mcp-cwd-"));
	dirs.push(home, cwd);
	mkdirSync(join(home, ".cursor"));
	return { home, cwd };
}

function runOptions(home: string, cwd: string) {
	return {
		cwd,
		env: { HOME: home, CI: "true" },
		snapshot: false as const,
	};
}

function assertNoSecret(stdout: string, stderr: string) {
	expect(stdout).not.toContain(SECRET);
	expect(stderr).not.toContain(SECRET);
	expect(stdout).not.toMatch(/napi_/);
	expect(stderr).not.toMatch(/napi_/);
}

describe("neon mcp", () => {
	test("mints an account key and writes a global Cursor config", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stdout, stderr } = await testCliCommand(
			["mcp", "-y"],
			runOptions(home, cwd),
		);

		const configPath = join(home, ".cursor", "mcp.json");
		const written = JSON.parse(readFileSync(configPath, "utf8"));
		expect(written.mcpServers.Neon).toMatchObject({
			url: NEON_MCP_URL,
			headers: { Authorization: `Bearer ${SECRET}` },
		});
		expect(statSync(configPath).mode & 0o777).toBe(0o600);
		expect(stdout).toContain("cursor");
		expect(stdout).toContain("installed");
		expect(stderr).toMatch(/Minted API key neon-cli-mcp-/);
		expect(stderr).toMatch(/api-keys revoke 201/);
		expect(stderr).toMatch(/everything your account can/);
		assertNoSecret(stdout, stderr);
	});

	test("reuses an existing Neon Bearer on a second run", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		await testCliCommand(["mcp", "-y"], runOptions(home, cwd));
		const { stderr } = await testCliCommand(
			["mcp", "-y"],
			runOptions(home, cwd),
		);
		expect(stderr).toMatch(/Reusing the API key/);
		expect(stderr).not.toMatch(/Minted API key/);
		assertNoSecret("", stderr);
	});

	test("--oauth writes no header and does not mint, without a CLI credential", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stdout, stderr } = await testCliCommand(
			["mcp", "-y", "--oauth"],
			{ ...runOptions(home, cwd), apiKey: false },
		);

		const written = JSON.parse(
			readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.Neon).toMatchObject({ url: NEON_MCP_URL });
		expect(stderr).not.toMatch(/Minted API key/);
		expect(stderr).not.toMatch(/Cannot run interactive auth/);
		expect(stderr).toMatch(/prompt for Neon sign-in/);
		expect(stdout).toContain("installed");
		assertNoSecret(stdout, stderr);
	});

	test("unauthenticated mint path names --oauth", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stderr } = await testCliCommand(["mcp", "-y"], {
			...runOptions(home, cwd),
			apiKey: false,
			code: 1,
		});
		expect(stderr).toMatch(/Authentication required/);
		expect(stderr).toMatch(/--oauth/);
		expect(stderr).not.toMatch(/Minted API key/);
	});

	test("replaces a key-backed entry when switching to --oauth", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		await testCliCommand(["mcp", "-y"], runOptions(home, cwd));
		await testCliCommand(["mcp", "-y", "--oauth"], runOptions(home, cwd));
		const written = JSON.parse(
			readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.Neon.headers).toBeUndefined();
	});

	test("--project mints an account key into the project config", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		mkdirSync(join(cwd, ".cursor"));
		writeFileSync(
			join(cwd, ".neon"),
			JSON.stringify({
				orgId: "org-7",
				projectId: "proj-in-org",
			}),
		);
		const { stderr } = await testCliCommand(
			["mcp", "-y", "--project"],
			runOptions(home, cwd),
		);

		const configPath = join(cwd, ".cursor", "mcp.json");
		const written = JSON.parse(readFileSync(configPath, "utf8"));
		expect(written.mcpServers.Neon.headers.Authorization).toBe(
			`Bearer ${SECRET}`,
		);
		expect(written.mcpServers.Neon.url).toBe(NEON_MCP_URL);
		expect(statSync(configPath).mode & 0o777).toBe(0o600);
		expect(readFileSync(join(cwd, ".cursor", ".gitignore"), "utf8")).toBe(
			"mcp.json\n",
		);
		expect(stderr).toMatch(/, account/);
		expect(stderr).toMatch(/everything your account can/);
		expect(stderr).not.toMatch(/--org-id/);
		assertNoSecret("", stderr);
	});

	test("--project without a linked project still mints an account key", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		mkdirSync(join(cwd, ".cursor"));
		const { stdout, stderr } = await testCliCommand(
			["mcp", "-y", "--project"],
			runOptions(home, cwd),
		);
		const written = JSON.parse(
			readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.Neon.headers.Authorization).toBe(
			`Bearer ${SECRET}`,
		);
		expect(stdout).toContain("installed");
		expect(stderr).toMatch(/Minted API key/);
		expect(stderr).not.toMatch(/No Neon project linked/);
		assertNoSecret(stdout, stderr);
	});

	test("bare mcp in CI without -y refuses to mint into detected agents", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stderr } = await testCliCommand(["mcp"], {
			...runOptions(home, cwd),
			code: 1,
		});
		expect(stderr).toMatch(/Pass -y to mint into every detected agent/);
		expect(stderr).toMatch(/--agent <name>/);
		expect(stderr).toMatch(/--oauth/);
		expect(stderr).not.toMatch(/Minted API key/);
		expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
	});

	test("--oauth without -y still installs into detected agents", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stdout, stderr } = await testCliCommand(["mcp", "--oauth"], {
			...runOptions(home, cwd),
			apiKey: false,
		});
		expect(
			readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
		).toContain("mcp.neon.tech");
		expect(stderr).not.toMatch(/Minted API key/);
		expect(stdout).toContain("installed");
		assertNoSecret(stdout, stderr);
	});

	test("-y installs globally into detected agents", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stdout, stderr } = await testCliCommand(
			["mcp", "-y"],
			runOptions(home, cwd),
		);
		const written = JSON.parse(
			readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.Neon).toMatchObject({
			url: NEON_MCP_URL,
			headers: { Authorization: `Bearer ${SECRET}` },
		});
		expect(stdout).toContain("cursor");
		expect(stdout).toContain("installed");
		expect(stderr).toMatch(/Minted API key/);
		assertNoSecret(stdout, stderr);
	});

	test("-y --project detects agents from the project folder", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		mkdirSync(join(cwd, ".cursor"));
		writeFileSync(
			join(cwd, ".neon"),
			JSON.stringify({
				orgId: "org-7",
				projectId: "proj-in-org",
			}),
		);
		const { stderr } = await testCliCommand(
			["mcp", "-y", "--project"],
			runOptions(home, cwd),
		);
		const written = JSON.parse(
			readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.Neon.url).toBe(NEON_MCP_URL);
		expect(written.mcpServers.Neon.headers.Authorization).toBe(
			`Bearer ${SECRET}`,
		);
		expect(stderr).toMatch(/, account/);
		expect(stderr).toMatch(/everything your account can/);
		expect(stderr).not.toMatch(/--org-id/);
	});

	test("-y --project does not use a global install as project detection", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		writeFileSync(
			join(cwd, ".neon"),
			JSON.stringify({
				orgId: "org-7",
				projectId: "proj-in-org",
			}),
		);
		const { stderr } = await testCliCommand(["mcp", "-y", "--project"], {
			...runOptions(home, cwd),
			code: 1,
		});
		expect(stderr).toMatch(/No coding agents detected in this project/);
		expect(stderr).not.toMatch(/Minted API key/);
	});

	test("-y --project --oauth does not need a linked project", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		mkdirSync(join(cwd, ".cursor"));
		const { stdout, stderr } = await testCliCommand(
			["mcp", "-y", "--project", "--oauth"],
			{ ...runOptions(home, cwd), apiKey: false },
		);
		const written = JSON.parse(
			readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.Neon).toMatchObject({ url: NEON_MCP_URL });
		expect(written.mcpServers.Neon.headers).toBeUndefined();
		expect(stderr).not.toMatch(/Minted API key/);
		expect(stdout).toContain("installed");
		assertNoSecret(stdout, stderr);
	});

	test("exits non-zero when one write fails next to a success", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		mkdirSync(join(home, ".claude"));
		mkdirSync(join(home, ".claude.json"));
		const { stdout, stderr } = await testCliCommand(["mcp", "-y"], {
			...runOptions(home, cwd),
			code: 1,
		});
		expect(stdout).toContain("cursor");
		expect(stdout).toContain("installed");
		expect(stdout).toContain("claude-code");
		expect(stdout).toContain("failed");
		expect(stderr).toMatch(/Minted API key/);
		expect(stderr).not.toMatch(/has been revoked/);
		expect(stderr).toMatch(
			/Failed to write Neon MCP config for: claude-code/,
		);
	});

	test("--project refuses a tracked MCP config before minting", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		mkdirSync(join(cwd, ".cursor"), { recursive: true });
		writeFileSync(join(cwd, ".cursor", "mcp.json"), "{}\n");
		execFileSync("git", ["-C", cwd, "init"], { stdio: "ignore" });
		execFileSync("git", ["-C", cwd, "add", "--", ".cursor/mcp.json"], {
			stdio: "ignore",
		});
		const { stderr } = await testCliCommand(["mcp", "-y", "--project"], {
			...runOptions(home, cwd),
			code: 1,
		});
		expect(stderr).toMatch(/tracked by git/);
		expect(stderr).not.toMatch(/Minted API key/);
	});

	test("revokes the minted key when every write fails", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		mkdirSync(join(home, ".cursor", "mcp.json"));
		const { stderr } = await testCliCommand(["mcp", "-y"], {
			...runOptions(home, cwd),
			code: 1,
		});
		expect(stderr).toMatch(/has been revoked/);
	});

	test("does not print a YAML parse excerpt that contains a secret", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		mkdirSync(join(home, ".config", "goose"), { recursive: true });
		writeFileSync(
			join(home, ".config", "goose", "config.yaml"),
			`extensions:
  neon:
    uri: ${NEON_MCP_URL}
    headers:
      Authorization: Bearer napi_secret_yaml
    bad: [unterminated
`,
		);
		const { stdout, stderr } = await testCliCommand(
			["mcp", "-y", "--oauth"],
			{ ...runOptions(home, cwd), apiKey: false, code: 1 },
		);
		assertNoSecret(stdout, stderr);
		expect(`${stdout}${stderr}`).not.toContain("napi_secret_yaml");
		expect(stdout).toContain("cursor");
		expect(stdout).toContain("installed");
		expect(stdout).toContain("goose");
		expect(stdout).toContain("failed");
	});

	test("an organization CLI key cannot mint", async ({ testCliCommand }) => {
		const { home, cwd } = scratch();
		const { stderr } = await testCliCommand(["mcp", "-y"], {
			...runOptions(home, cwd),
			mockDir: "org-key",
			code: 1,
		});
		expect(stderr).toMatch(/cannot mint API keys/);
		expect(stderr).not.toMatch(/everything your account can/);
	});

	test("-y with no installed apps and no host fails without minting", async ({
		testCliCommand,
	}) => {
		const home = mkdtempSync(join(tmpdir(), "neon-mcp-empty-home-"));
		const cwd = mkdtempSync(join(tmpdir(), "neon-mcp-empty-cwd-"));
		dirs.push(home, cwd);
		const { stderr } = await testCliCommand(["mcp", "-y"], {
			...runOptions(home, cwd),
			code: 1,
		});
		expect(stderr).toMatch(/No coding agents detected/);
		expect(stderr).toMatch(/--agent <name>/);
		expect(stderr).not.toMatch(/claude-desktop/);
		expect(stderr).not.toMatch(/Minted API key/);
	});

	test("--read-only writes ?readonly=true and does not mint on --oauth", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stderr } = await testCliCommand(
			["mcp", "-y", "--oauth", "--read-only"],
			{ ...runOptions(home, cwd), apiKey: false },
		);
		const written = JSON.parse(
			readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.Neon.url).toBe(
			neonMcpUrl({ readOnly: true }),
		);
		expect(written.mcpServers.Neon.headers).toBeUndefined();
		expect(stderr).toMatch(/\?readonly=true/);
	});

	test("--project-id writes ?projectId= with a project-scoped key", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stderr } = await testCliCommand(
			["mcp", "-y", "--project-id", "proj-in-org"],
			runOptions(home, cwd),
		);
		const written = JSON.parse(
			readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.Neon.url).toBe(
			neonMcpUrl({ projectId: "proj-in-org" }),
		);
		expect(written.mcpServers.Neon.headers.Authorization).toBe(
			`Bearer ${PROJECT_SECRET}`,
		);
		expect(stderr).toMatch(/Minted API key/);
		expect(stderr).toMatch(/, project/);
		expect(stderr).toMatch(/Limited to proj-in-org/);
		expect(stderr).toMatch(/api-keys revoke 303 --org-id org-7/);
		expect(stderr).not.toMatch(/everything your account can/);
		expect(stderr).toMatch(/\?projectId=proj-in-org/);
		assertNoSecret("", stderr);
	});

	test("--project-id that looks like an org id does not suggest --org-id", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stderr } = await testCliCommand(
			["mcp", "-y", "--project-id", "org-7"],
			{ ...runOptions(home, cwd), code: 1 },
		);
		expect(stderr).toMatch(/looks like an organization id/);
		expect(stderr).toMatch(/neon mcp takes a project id on --project-id/);
		expect(stderr).not.toMatch(/Pass it as --org-id/);
		expect(stderr).not.toMatch(/Minted API key/);
		expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
	});

	test("a project with no organization names --oauth", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stderr } = await testCliCommand(
			["mcp", "-y", "--project-id", "test"],
			{ ...runOptions(home, cwd), code: 1 },
		);
		expect(stderr).toMatch(/does not belong to an organization/);
		expect(stderr).toMatch(/Pass --oauth to pin tools without minting/);
		expect(stderr).not.toMatch(
			/Omit --project-id to create an account key/,
		);
		expect(stderr).not.toMatch(/Minted API key/);
		expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
	});

	test("unknown --project-id fails without minting", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stderr } = await testCliCommand(
			["mcp", "-y", "--project-id", "proj-flag"],
			{ ...runOptions(home, cwd), code: 1 },
		);
		expect(stderr).toMatch(/Project proj-flag not found/);
		expect(stderr).not.toMatch(/Minted API key/);
		expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
	});

	test("a project-scoped mint with the wrong project_id is withdrawn", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stderr } = await testCliCommand(
			["mcp", "-y", "--project-id", "proj-mismatch"],
			{ ...runOptions(home, cwd), code: 1 },
		);
		expect(stderr).toMatch(
			/scoped to some-other-project rather than proj-mismatch/,
		);
		expect(stderr).toMatch(/has been revoked/);
		expect(stderr).not.toMatch(/Minted API key/);
		expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
		assertNoSecret("", stderr);
	});

	test("--category accepts repeated flags and CSV", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		await testCliCommand(
			[
				"mcp",
				"-y",
				"--oauth",
				"--category",
				"querying",
				"--category",
				"schema,docs",
			],
			{ ...runOptions(home, cwd), apiKey: false },
		);
		const written = JSON.parse(
			readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.Neon.url).toBe(
			neonMcpUrl({ categories: ["querying", "schema", "docs"] }),
		);
	});

	test("unknown --category fails without writing", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stderr } = await testCliCommand(
			["mcp", "-y", "--oauth", "--category", "nope"],
			{ ...runOptions(home, cwd), apiKey: false, code: 1 },
		);
		expect(stderr).toMatch(/Unknown MCP category: "nope"/);
		expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
	});

	test("bare --category fails instead of installing", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stderr } = await testCliCommand(
			["mcp", "-y", "--oauth", "--category"],
			{ ...runOptions(home, cwd), apiKey: false, code: 1 },
		);
		expect(stderr).toMatch(/--category needs a value/);
		expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
	});

	test("-y --project does not add ?projectId= from .neon", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		mkdirSync(join(cwd, ".cursor"));
		writeFileSync(
			join(cwd, ".neon"),
			JSON.stringify({
				orgId: "org-7",
				projectId: "proj-in-org",
			}),
		);
		await testCliCommand(["mcp", "-y", "--project", "--oauth"], {
			...runOptions(home, cwd),
			apiKey: false,
		});
		const written = JSON.parse(
			readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.Neon.url).toBe(NEON_MCP_URL);
	});

	test("--project --project-id scopes the key to the flag, not .neon", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		mkdirSync(join(cwd, ".cursor"));
		writeFileSync(
			join(cwd, ".neon"),
			JSON.stringify({
				orgId: "org-7",
				projectId: "proj-from-neon",
			}),
		);
		const { stderr } = await testCliCommand(
			["mcp", "-y", "--project", "--project-id", "proj-in-org"],
			runOptions(home, cwd),
		);
		const written = JSON.parse(
			readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.Neon.url).toBe(
			neonMcpUrl({ projectId: "proj-in-org" }),
		);
		expect(written.mcpServers.Neon.headers.Authorization).toBe(
			`Bearer ${PROJECT_SECRET}`,
		);
		expect(stderr).toMatch(/Minted API key/);
		expect(stderr).toMatch(/, project/);
		expect(stderr).toMatch(/Limited to proj-in-org/);
		expect(stderr).toMatch(/api-keys revoke 303 --org-id org-7/);
		expect(stderr).not.toMatch(/proj-from-neon/);
		expect(stderr).toMatch(/\?projectId=proj-in-org/);
		assertNoSecret("", stderr);
	});

	test("--oauth --project-id writes ?projectId= and no header", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stderr } = await testCliCommand(
			["mcp", "-y", "--oauth", "--project-id", "proj-flag"],
			{ ...runOptions(home, cwd), apiKey: false },
		);
		const written = JSON.parse(
			readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.Neon.url).toBe(
			neonMcpUrl({ projectId: "proj-flag" }),
		);
		expect(written.mcpServers.Neon.headers).toBeUndefined();
		expect(stderr).not.toMatch(/Minted API key/);
		expect(stderr).toMatch(/\?projectId=proj-flag/);
	});

	test("reuses a Bearer then rewrites the URL query", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		await testCliCommand(["mcp", "-y"], runOptions(home, cwd));
		const { stderr } = await testCliCommand(
			["mcp", "-y", "--project-id", "proj-in-org"],
			runOptions(home, cwd),
		);
		const written = JSON.parse(
			readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.Neon.url).toBe(
			neonMcpUrl({ projectId: "proj-in-org" }),
		);
		expect(written.mcpServers.Neon.headers.Authorization).toBe(
			`Bearer ${SECRET}`,
		);
		expect(stderr).toMatch(/Reusing the API key/);
		expect(stderr).toMatch(/keeps its existing scope/);
		expect(stderr).toMatch(/--oauth/);
		expect(stderr).not.toMatch(/Minted API key/);
		expect(stderr).toMatch(/\?projectId=proj-in-org/);
	});

	test("revokes a project-scoped key when every write fails", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		mkdirSync(join(home, ".cursor", "mcp.json"));
		const { stderr } = await testCliCommand(
			["mcp", "-y", "--project-id", "proj-in-org"],
			{ ...runOptions(home, cwd), code: 1 },
		);
		expect(stderr).toMatch(/has been revoked/);
		expect(stderr).not.toMatch(/could NOT be revoked/);
	});

	test("failed project-key revoke names --org-id", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		mkdirSync(join(home, ".cursor", "mcp.json"));
		const { stderr } = await testCliCommand(
			["mcp", "-y", "--project-id", "proj-revoke-fail"],
			{ ...runOptions(home, cwd), code: 1 },
		);
		expect(stderr).toMatch(/could NOT be revoked/);
		expect(stderr).toMatch(/api-keys revoke 500 --org-id org-7/);
		assertNoSecret("", stderr);
	});

	test("help lists the server URL, -y defaults, and supported agents", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stdout, stderr } = await testCliCommand(["mcp", "--help"], {
			...runOptions(home, cwd),
		});
		const compact = strip(`${stdout}\n${stderr}`).replace(/\s+/g, "");
		expect(stdout).toBe("");
		expect(compact).toContain(NEON_MCP_URL);
		expect(compact).toContain("globalconfig");
		expect(compact).toContain("globallyinstalledapps");
		expect(compact).toContain("account-widekey");
		expect(compact).toContain("noprojectpin");
		expect(compact).toContain("allcategories");
		expect(compact).toContain("-a,--agent");
		for (const agent of mcpInstallableAgents("global")) {
			expect(compact).toContain(agent);
		}
		for (const category of NEON_MCP_CATEGORIES) {
			expect(compact).toContain(category);
		}
	});

	test("installs without -y when --agent is set", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stdout, stderr } = await testCliCommand(
			["mcp", "--agent", "cursor"],
			runOptions(home, cwd),
		);
		const written = JSON.parse(
			readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.Neon.url).toBe(NEON_MCP_URL);
		expect(stdout).toContain("cursor");
		expect(stdout).toContain("installed");
		expect(stderr).toMatch(/Minted API key/);
		assertNoSecret(stdout, stderr);
	});

	test("bare --agent fails instead of installing into every detected agent", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stderr } = await testCliCommand(["mcp", "--oauth", "--agent"], {
			...runOptions(home, cwd),
			apiKey: false,
			code: 1,
		});
		expect(stderr).toMatch(/--agent needs a value/);
		expect(stderr).not.toMatch(/Minted API key/);
		expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
	});

	test("-y --agent with no value fails instead of minting into detected agents", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stderr } = await testCliCommand(["mcp", "-y", "--agent"], {
			...runOptions(home, cwd),
			code: 1,
		});
		expect(stderr).toMatch(/--agent needs a value/);
		expect(stderr).not.toMatch(/Minted API key/);
		expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
	});

	test("--agent followed by another flag fails instead of treating the flag as omitted", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stderr } = await testCliCommand(["mcp", "--agent", "--oauth"], {
			...runOptions(home, cwd),
			apiKey: false,
			code: 1,
		});
		expect(stderr).toMatch(/--agent needs a value/);
		expect(stderr).not.toMatch(/Minted API key/);
		expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
	});

	test("unknown --agent fails without minting", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stderr } = await testCliCommand(
			["mcp", "--agent", "not-an-agent"],
			{ ...runOptions(home, cwd), code: 1 },
		);
		expect(stderr).toMatch(/Unknown agent: "not-an-agent"/);
		expect(stderr).not.toMatch(/Minted API key/);
	});
});
