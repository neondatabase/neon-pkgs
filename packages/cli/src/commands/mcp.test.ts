import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";

import { NEON_MCP_URL } from "../mcp/install.js";
import { test } from "../test_utils/fixtures";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const SECRET = "napi_account_secret";

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
			["mcp", "--agent", "cursor"],
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
		await testCliCommand(
			["mcp", "--agent", "cursor"],
			runOptions(home, cwd),
		);
		const { stderr } = await testCliCommand(
			["mcp", "--agent", "cursor"],
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
			["mcp", "--oauth", "--agent", "cursor"],
			{ ...runOptions(home, cwd), apiKey: false },
		);

		const written = JSON.parse(
			readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.Neon).toMatchObject({ url: NEON_MCP_URL });
		expect(stderr).not.toMatch(/Minted API key/);
		expect(stderr).not.toMatch(/Cannot run interactive auth/);
		expect(stdout).toContain("installed");
		assertNoSecret(stdout, stderr);
	});

	test("replaces a key-backed entry when switching to --oauth", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		await testCliCommand(
			["mcp", "--agent", "cursor"],
			runOptions(home, cwd),
		);
		await testCliCommand(
			["mcp", "--oauth", "--agent", "cursor"],
			runOptions(home, cwd),
		);
		const written = JSON.parse(
			readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.Neon.headers).toBeUndefined();
	});

	test("--project mints a project-scoped key into the project config", async ({
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
		const { stderr } = await testCliCommand(
			["mcp", "--project", "--agent", "cursor"],
			runOptions(home, cwd),
		);

		const configPath = join(cwd, ".cursor", "mcp.json");
		const written = JSON.parse(readFileSync(configPath, "utf8"));
		expect(written.mcpServers.Neon.headers.Authorization).toBe(
			`Bearer napi_org_secret`,
		);
		expect(statSync(configPath).mode & 0o777).toBe(0o600);
		expect(readFileSync(join(cwd, ".cursor", ".gitignore"), "utf8")).toBe(
			"mcp.json\n",
		);
		expect(stderr).toMatch(/project proj-in-org/);
		expect(stderr).toMatch(/--org-id org-7/);
		expect(stderr).not.toContain("napi_org_secret");
	});

	test("--project without a linked project fails before minting", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stderr } = await testCliCommand(
			["mcp", "--project", "--agent", "cursor"],
			{ ...runOptions(home, cwd), code: 1 },
		);
		expect(stderr).toMatch(/No Neon project linked/);
		expect(stderr).not.toMatch(/Minted API key/);
	});

	test("detects a globally installed agent for --project in a fresh directory", async ({
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
		await testCliCommand(["mcp", "--project"], runOptions(home, cwd));
		expect(
			readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"),
		).toContain("mcp.neon.tech");
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

	test("unsupported --agent fails without minting", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stderr } = await testCliCommand(
			["mcp", "--agent", "claude-desktop"],
			{ ...runOptions(home, cwd), code: 1 },
		);
		expect(stderr).toMatch(/Connectors/i);
		expect(stderr).not.toMatch(/Minted API key/);
	});

	test("keeps a minted key when some agents succeed and others are skipped", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		const { stdout, stderr } = await testCliCommand(
			["mcp", "--agent", "cursor", "--agent", "claude-desktop"],
			runOptions(home, cwd),
		);
		expect(stdout).toContain("cursor");
		expect(stdout).toContain("installed");
		expect(stdout).toContain("claude-desktop");
		expect(stdout).toContain("skipped");
		expect(stderr).toMatch(/Minted API key/);
		expect(stderr).not.toMatch(/has been revoked/);
	});

	test("revokes the minted key when every write fails", async ({
		testCliCommand,
	}) => {
		const { home, cwd } = scratch();
		mkdirSync(join(home, ".cursor", "mcp.json"));
		const { stderr } = await testCliCommand(["mcp", "--agent", "cursor"], {
			...runOptions(home, cwd),
			code: 1,
		});
		expect(stderr).toMatch(/has been revoked/);
	});

	test("an organization CLI key cannot mint", async ({ testCliCommand }) => {
		const { home, cwd } = scratch();
		const { stderr } = await testCliCommand(["mcp", "--agent", "cursor"], {
			...runOptions(home, cwd),
			mockDir: "org-key",
			code: 1,
		});
		expect(stderr).toMatch(/cannot mint API keys/);
	});

	test("no --agent and no detected agents fails without minting", async ({
		testCliCommand,
	}) => {
		const home = mkdtempSync(join(tmpdir(), "neon-mcp-empty-home-"));
		const cwd = mkdtempSync(join(tmpdir(), "neon-mcp-empty-cwd-"));
		dirs.push(home, cwd);
		const { stderr } = await testCliCommand(["mcp"], {
			...runOptions(home, cwd),
			code: 1,
		});
		expect(stderr).toMatch(/No coding agents detected/);
		expect(stderr).not.toMatch(/Minted API key/);
	});
});
