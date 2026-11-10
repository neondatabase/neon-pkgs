/**
 * `neon mcp serve` with an OAuth profile, against local OAuth and Neon API servers. The bridge
 * itself is covered live in `e2e/mcp-serve.e2e.test.ts`; stdin is closed at once here, so the
 * command resolves its credential and exits without reaching mcp.neon.tech.
 */

import { type ChildProcess, fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type NeonApiServer,
	startNeonApiServer,
} from "../test_utils/neon_api_server.js";
import {
	type RotatingOauthServer,
	startRotatingOauthServer,
} from "../test_utils/rotating_oauth_server.js";

let oauth: RotatingOauthServer;
let api: NeonApiServer;
let configDir = "";
const running = new Set<ChildProcess>();

const credentialsFile = () => join(configDir, "credentials.json");

beforeEach(async () => {
	oauth = await startRotatingOauthServer();
	api = await startNeonApiServer();
	configDir = mkdtempSync(join(tmpdir(), "neon-mcp-serve-"));
});

afterEach(async () => {
	for (const child of running) child.kill("SIGKILL");
	running.clear();
	rmSync(configDir, { recursive: true, force: true });
	await Promise.all([oauth.stop(), api.stop()]);
});

const seedSession = (overrides: Record<string, unknown> = {}) => {
	const issued = oauth.issue();
	writeFileSync(
		credentialsFile(),
		JSON.stringify({
			...issued,
			type: "oauth",
			expires_at: Date.now() + issued.expires_in * 1000,
			user_id: "user-1",
			...overrides,
		}),
		{ mode: 0o600 },
	);
};

const readStored = (): Record<string, unknown> =>
	JSON.parse(readFileSync(credentialsFile(), "utf8"));

const runCli = (
	args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> => {
	const child = fork(
		join(process.cwd(), "./dist/index.js"),
		[
			"--config-dir",
			configDir,
			"--api-host",
			api.url,
			"--oauth-host",
			oauth.url,
			"--client-id",
			"test-client",
			"--no-analytics",
			...args,
		],
		{
			stdio: "pipe",
			env: {
				PATH: process.env.PATH ?? "",
				HOME: configDir,
				CI: "true",
				FORCE_COLOR: "false",
			},
		},
	);
	running.add(child);
	child.stdin?.end();
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (d: Buffer) => {
		stdout += d.toString();
	});
	child.stderr?.on("data", (d: Buffer) => {
		stderr += d.toString();
	});
	return new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => {
			running.delete(child);
			resolve({ code: code ?? -1, stdout, stderr });
		});
	});
};

describe("neon mcp serve with an OAuth profile", () => {
	it("mints one API key, stores it with the session, and reuses it", async () => {
		seedSession();

		const first = await runCli(["mcp", "serve"]);
		expect(first.code).toBe(0);
		expect(first.stdout).toBe("");
		expect(first.stderr).toContain(
			'for the Neon MCP server and stored it with profile "DEFAULT"',
		);
		expect(api.mintedKeys()).toHaveLength(1);
		const [minted] = api.mintedKeys();
		expect(minted.name).toMatch(/^neon-cli-mcp-/);
		expect(readStored()).toMatchObject({
			type: "oauth",
			mcp_api_key: minted.key,
			mcp_key_id: minted.id,
		});

		const second = await runCli(["mcp", "serve"]);
		expect(second.code).toBe(0);
		expect(second.stderr).not.toContain("Minted API key");
		expect(api.mintedKeys()).toHaveLength(1);
	});

	it("keeps the stored key across a token refresh", async () => {
		seedSession({
			expires_at: Date.now() - 1000,
			mcp_api_key: "napi_stored",
			mcp_key_id: 42,
		});

		const result = await runCli(["mcp", "serve"]);

		expect(result.code).toBe(0);
		expect(oauth.rotations()).toBe(1);
		expect(api.mintedKeys()).toHaveLength(0);
		expect(readStored()).toMatchObject({
			mcp_api_key: "napi_stored",
			mcp_key_id: 42,
		});
	});

	it("revokes the stored key when the profile is removed", async () => {
		seedSession({ mcp_api_key: "napi_stored", mcp_key_id: 42 });

		const result = await runCli(["profile", "remove", "DEFAULT", "--yes"]);

		expect(result.code).toBe(0);
		expect(api.revokedKeyIds()).toEqual([42]);
		expect(result.stderr).toContain(
			"Revoked the Neon MCP server's API key (id 42)",
		);
	});

	it("fails without starting a sign-in when no credential is stored", async () => {
		const result = await runCli(["mcp", "serve"]);

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(
			"Not signed in. Run `neon login`, pass --api-key, or set NEON_API_KEY.",
		);
	});
});
