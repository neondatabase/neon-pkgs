/** Forks `dist/index.js` because the 401 retry loop lives there. `CI=true` turns a browser fallback into a test failure. */

import { type ChildProcess, fork } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
const cliEntry = () => join(process.cwd(), "./dist/index.js");

beforeEach(async () => {
	oauth = await startRotatingOauthServer();
	api = await startNeonApiServer();
	configDir = mkdtempSync(join(tmpdir(), "neon-auth-refresh-"));
});

afterEach(async () => {
	for (const child of running) child.kill("SIGKILL");
	running.clear();
	rmSync(configDir, { recursive: true, force: true });
	await Promise.all([oauth.stop(), api.stop()]);
});

const seedCredentials = (
	overrides: Record<string, unknown> = {},
): Record<string, unknown> => {
	const issued = oauth.issue();
	const stored = {
		...issued,
		type: "oauth",
		expires_at: Date.now() + issued.expires_in * 1000,
		user_id: "user-1",
		...overrides,
	};
	writeFileSync(credentialsFile(), JSON.stringify(stored), { mode: 0o600 });
	return stored;
};

const readStored = (): Record<string, unknown> =>
	JSON.parse(readFileSync(credentialsFile(), "utf8"));

type RunResult = { code: number; stdout: string; stderr: string };

const runCli = (args: string[] = ["me"]): Promise<RunResult> => {
	if (!existsSync(cliEntry())) {
		throw new Error(
			`Built CLI missing at ${cliEntry()}. Run pnpm --filter neon build first.`,
		);
	}
	const child = fork(
		cliEntry(),
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
			"--output",
			"json",
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

	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (d: Buffer) => {
		stdout += d.toString();
	});
	child.stderr?.on("data", (d: Buffer) => {
		stderr += d.toString();
	});

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(
				new Error(
					`neon ${args.join(" ")} did not exit within 30s.\nstdout: ${stdout}\nstderr: ${stderr}`,
				),
			);
		}, 30_000);

		child.on("error", (err) => {
			clearTimeout(timer);
			running.delete(child);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			running.delete(child);
			resolve({ code: code ?? -1, stdout, stderr });
		});
	});
};

describe("a valid session", () => {
	it("is used as-is, without contacting the authorization server", async () => {
		seedCredentials();

		const result = await runCli();

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("user@example.com");
		expect(oauth.refreshAttempts()).toBe(0);
	});
});

describe("an expired session", () => {
	it("is refreshed, and the rotated token set replaces the old one", async () => {
		const before = seedCredentials({ expires_at: Date.now() - 1000 });

		const result = await runCli();

		expect(result.code).toBe(0);
		expect(oauth.rotations()).toBe(1);

		const after = readStored();
		expect(after.access_token).not.toBe(before.access_token);
		expect(after.refresh_token).not.toBe(before.refresh_token);
		expect(after.user_id).toBe("user-1");
	});

	it("keeps the rotated token even when the command afterwards fails", async () => {
		const before = seedCredentials({ expires_at: Date.now() - 1000 });
		api.failUserLookup(true);

		const failed = await runCli();
		expect(failed.code).toBe(1);
		expect(oauth.rotations()).toBe(1);

		const persisted = readStored();
		expect(persisted.access_token).not.toBe(before.access_token);

		api.failUserLookup(false);
		const recovered = await runCli();
		expect(recovered.code).toBe(0);
		expect(oauth.rotations()).toBe(1);
	});

	it("is left alone when the authorization server cannot be reached", async () => {
		const before = seedCredentials({ expires_at: Date.now() - 1000 });
		oauth.setUnreachable(true);

		const result = await runCli();

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"Could not reach the Neon authorization server",
		);
		expect(readStored().refresh_token).toBe(before.refresh_token);
	});

	it("reports a dead grant instead of opening a browser", async () => {
		const before = seedCredentials({ expires_at: Date.now() - 1000 });
		oauth.revoke(before.refresh_token as string);

		const result = await runCli();

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("invalid_grant");
		expect(result.stderr).toContain("neon auth --profile");
		expect(result.stderr).not.toContain(
			"Cannot run interactive auth in CI",
		);
		expect(existsSync(credentialsFile())).toBe(true);
	});
});

describe("concurrent invocations", () => {
	it("share a single rotation instead of invalidating each other", async () => {
		seedCredentials({ expires_at: Date.now() - 1000 });

		const [first, second] = await Promise.all([runCli(), runCli()]);

		expect(oauth.refreshAttempts()).toBe(1);
		expect(oauth.rotations()).toBe(1);
		expect(first.code).toBe(0);
		expect(second.code).toBe(0);
		expect(readStored().expires_at).toBeGreaterThan(Date.now());
	});
});

describe("a 401 from the Neon API", () => {
	it("is recovered by refreshing, not by deleting the credentials", async () => {
		const before = seedCredentials();
		api.reject(before.access_token as string);

		const result = await runCli();

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("user@example.com");
		expect(oauth.rotations()).toBe(1);
		expect(existsSync(credentialsFile())).toBe(true);
	});

	it("keeps the credentials when the grant is dead", async () => {
		const before = seedCredentials();
		api.reject(before.access_token as string);
		oauth.revoke(before.refresh_token as string);

		const result = await runCli();

		expect(result.code).toBe(1);
		expect(existsSync(credentialsFile())).toBe(true);
		expect(result.stderr).toContain("invalid_grant");
		expect(result.stderr).not.toContain("deleting credentials");
	});

	it("keeps the credentials when the refresh cannot reach the server", async () => {
		const before = seedCredentials();
		api.reject(before.access_token as string);
		oauth.setUnreachable(true);

		const result = await runCli();

		expect(result.code).toBe(1);
		expect(existsSync(credentialsFile())).toBe(true);
		expect(readStored().refresh_token).toBe(before.refresh_token);
	});

	it("reports an API key rejection without touching stored credentials", async () => {
		seedCredentials();
		api.rejectAll(true);

		const result = await runCli(["me", "--api-key", "some-key"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("rejected the API key");
		expect(oauth.refreshAttempts()).toBe(0);
		expect(existsSync(credentialsFile())).toBe(true);
	});
});

describe("a damaged credentials file", () => {
	it("is reported rather than silently replaced with a new sign-in", async () => {
		writeFileSync(credentialsFile(), '{"access_token": "abc', {
			mode: 0o600,
		});

		const result = await runCli();

		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(/not valid JSON/);
		expect(result.stderr).not.toContain(
			"Cannot run interactive auth in CI",
		);
	});
});
