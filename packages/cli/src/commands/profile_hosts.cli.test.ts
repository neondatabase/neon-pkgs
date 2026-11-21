/**
 * A named profile's recorded `apiHost` / `oauthHost`, through the built CLI.
 *
 * Two local Neon APIs stand in for two environments, so each case can assert which one a request
 * reached: `profileApi` is the one recorded on the profile, `otherApi` the one a flag or
 * `NEON_API_HOST` names. Spawned without `--api-host`, unlike the other CLI suites, because where
 * the host comes from is what is under test.
 */

import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import strip from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	type RotatingOauthServer,
	startRotatingOauthServer,
} from "../test_utils/rotating_oauth_server.js";

type Seen = { method: string; path: string; token: string };

type FakeApi = { url: string; seen: Seen[]; stop: () => Promise<void> };

/** Answers what `me`, `profile create --api-key`, `rotate-key` and `remove` call. */
const startApi = async (): Promise<FakeApi> => {
	const seen: Seen[] = [];
	let nextKeyId = 100;
	const server: Server = createServer((req, res) => {
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		const method = req.method ?? "GET";
		seen.push({
			method,
			path,
			token: (req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""),
		});
		const reply = (body: unknown) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (path === "/auth") {
			return reply({ account_id: "user-1", auth_method: "api_key_user" });
		}
		if (path === "/users/me") {
			return reply({ id: "user-1", email: "user@example.com" });
		}
		if (path === "/api_keys" && method === "POST") {
			nextKeyId += 1;
			return reply({
				id: nextKeyId,
				key: `napi_minted_${nextKeyId}`,
				name: "minted",
			});
		}
		const revoke = /^\/api_keys\/(\d+)$/.exec(path);
		if (revoke && method === "DELETE") {
			return reply({ id: Number(revoke[1]), revoked: true });
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ message: "Not Found" }));
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		seen,
		stop: () =>
			new Promise((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve())),
			),
	};
};

let profileApi: FakeApi;
let otherApi: FakeApi;
let oauth: RotatingOauthServer;
let configDir = "";

beforeEach(async () => {
	[profileApi, otherApi, oauth] = await Promise.all([
		startApi(),
		startApi(),
		startRotatingOauthServer(),
	]);
	configDir = mkdtempSync(join(tmpdir(), "neon-profile-hosts-"));
});

afterEach(async () => {
	rmSync(configDir, { recursive: true, force: true });
	await Promise.all([profileApi.stop(), otherApi.stop(), oauth.stop()]);
});

const writeConfig = (files: Record<string, unknown>): void => {
	for (const [name, contents] of Object.entries(files)) {
		writeFileSync(join(configDir, name), JSON.stringify(contents), {
			mode: 0o600,
		});
	}
};

const stageEntry = (extra: Record<string, unknown> = {}) => ({
	credentials: "credentials.stage.json",
	apiHost: profileApi.url,
	oauthHost: oauth.url,
	...extra,
});

const profilesFile = () =>
	JSON.parse(readFileSync(join(configDir, "profiles.json"), "utf8"));

type Run = { code: number | null; stdout: string; stderr: string };

const runCli = (
	args: string[],
	env: Record<string, string> = {},
): Promise<Run> =>
	new Promise((resolve, reject) => {
		const cp = fork(
			join(process.cwd(), "./dist/cli.js"),
			[
				"--config-dir",
				configDir,
				"--context-file",
				join(configDir, ".neon"),
				"--no-analytics",
				"--client-id",
				"test-client",
				...args,
			],
			{
				stdio: "pipe",
				env: {
					PATH: process.env.PATH ?? "",
					HOME: configDir,
					CI: "true",
					FORCE_COLOR: "false",
					...env,
				},
			},
		);
		cp.stdin?.end();
		let stdout = "";
		let stderr = "";
		cp.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		cp.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		cp.on("error", reject);
		cp.on("close", (code) =>
			resolve({ code, stdout: strip(stdout), stderr: strip(stderr) }),
		);
	});

const paths = (api: FakeApi) => api.seen.map((s) => `${s.method} ${s.path}`);

describe("recording hosts", () => {
	test("profile create records the typed hosts and verifies the key against them", async () => {
		const { code, stdout } = await runCli([
			"profile",
			"create",
			"stage",
			"--api-key",
			"napi_stage",
			"--api-host",
			profileApi.url,
			"--oauth-host",
			oauth.url,
			"--output",
			"json",
		]);

		expect(code).toBe(0);
		expect(profilesFile().profiles.stage).toMatchObject({
			apiHost: profileApi.url,
			oauthHost: oauth.url,
		});
		expect(JSON.parse(stdout)).toMatchObject({
			name: "stage",
			apiHost: profileApi.url,
			oauthHost: oauth.url,
		});
		expect(profileApi.seen).toContainEqual({
			method: "GET",
			path: "/auth",
			token: "napi_stage",
		});
	});

	test("re-creating without host flags keeps the recorded hosts", async () => {
		writeConfig({
			"profiles.json": { version: 1, profiles: { stage: stageEntry() } },
			"credentials.stage.json": { type: "api_key", api_key: "napi_old" },
		});

		const { code } = await runCli(
			["profile", "create", "stage", "--api-key", "napi_new"],
			{ NEON_API_HOST: otherApi.url },
		);

		expect(code).toBe(0);
		expect(profilesFile().profiles.stage).toMatchObject({
			apiHost: profileApi.url,
			oauthHost: oauth.url,
		});
		expect(paths(profileApi)).toContain("GET /auth");
		expect(otherApi.seen).toEqual([]);
	});

	test("moving a profile to another host revokes its minted key where it was issued", async () => {
		writeConfig({
			"profiles.json": { version: 1, profiles: { stage: stageEntry() } },
			"credentials.stage.json": {
				type: "api_key",
				api_key: "napi_old",
				key_id: 7,
			},
		});

		const { code } = await runCli([
			"profile",
			"create",
			"stage",
			"--api-key",
			"napi_new",
			"--api-host",
			otherApi.url,
		]);

		expect(code).toBe(0);
		expect(profilesFile().profiles.stage.apiHost).toBe(otherApi.url);
		expect(paths(otherApi)).toContain("GET /auth");
		expect(profileApi.seen).toContainEqual({
			method: "DELETE",
			path: "/api_keys/7",
			token: "napi_old",
		});
	});

	test("a host that is not a URL is refused before any request", async () => {
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"stage",
			"--api-key",
			"napi_stage",
			"--api-host",
			"console-stage.example",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("--api-host must be an http or https URL");
		expect(() => profilesFile()).toThrow();
	});
});

describe("using a profile's hosts", () => {
	beforeEach(() => {
		writeConfig({
			"profiles.json": { version: 1, profiles: { stage: stageEntry() } },
			"credentials.stage.json": {
				type: "api_key",
				api_key: "napi_stage",
			},
		});
	});

	test.each([
		["--profile", ["--profile", "stage"], {}],
		["NEON_PROFILE", [], { NEON_PROFILE: "stage" }],
	])("a profile selected with %s sends its key to its host, over NEON_API_HOST", async (_label, args, env) => {
		const { code } = await runCli(["me", ...args], {
			NEON_API_HOST: otherApi.url,
			...env,
		});

		expect(code).toBe(0);
		expect(profileApi.seen).toContainEqual({
			method: "GET",
			path: "/users/me",
			token: "napi_stage",
		});
		expect(otherApi.seen).toEqual([]);
	});

	test("--api-host overrides the recorded host", async () => {
		const { code } = await runCli([
			"me",
			"--profile",
			"stage",
			"--api-host",
			otherApi.url,
		]);

		expect(code).toBe(0);
		expect(paths(otherApi)).toContain("GET /users/me");
		expect(profileApi.seen).toEqual([]);
	});

	test("NEON_API_KEY that displaces NEON_PROFILE does not take the profile's host", async () => {
		const { code } = await runCli(["me"], {
			NEON_API_KEY: "napi_ambient",
			NEON_PROFILE: "stage",
			NEON_API_HOST: otherApi.url,
		});

		expect(code).toBe(0);
		expect(otherApi.seen).toContainEqual({
			method: "GET",
			path: "/users/me",
			token: "napi_ambient",
		});
		expect(profileApi.seen).toEqual([]);
	});

	test("profile list shows the hosts a profile records", async () => {
		const { code, stdout } = await runCli([
			"profile",
			"list",
			"-o",
			"json",
		]);

		expect(code).toBe(0);
		const rows: Array<Record<string, unknown>> = JSON.parse(stdout);
		expect(rows.find((r) => r.name === "stage")).toMatchObject({
			apiHost: profileApi.url,
			oauthHost: oauth.url,
		});
		expect(rows.find((r) => r.name === "DEFAULT")).not.toHaveProperty(
			"apiHost",
		);

		const table = await runCli(["profile", "list"]);
		expect(table.stdout).toMatch(/API Host/);
		expect(table.stdout).toContain(profileApi.url);
	});

	test("rotate-key and remove talk to the profile's host", async () => {
		writeConfig({
			"credentials.stage.json": {
				type: "api_key",
				api_key: "napi_stage",
				key_id: 7,
			},
		});

		const rotated = await runCli(["profile", "rotate-key", "stage"], {
			NEON_API_HOST: otherApi.url,
		});
		expect(rotated.code).toBe(0);
		expect(paths(profileApi)).toEqual(
			expect.arrayContaining(["POST /api_keys", "DELETE /api_keys/7"]),
		);

		const removed = await runCli(["profile", "remove", "stage", "--yes"], {
			NEON_API_HOST: otherApi.url,
		});
		expect(removed.code).toBe(0);
		expect(paths(profileApi)).toContain("DELETE /api_keys/101");
		expect(otherApi.seen).toEqual([]);
	});
});

test("an OAuth profile refreshes its session at its recorded OAuth host", async () => {
	const issued = oauth.issue();
	writeConfig({
		"profiles.json": { version: 1, profiles: { stage: stageEntry() } },
		"credentials.stage.json": {
			...issued,
			type: "oauth",
			expires_at: Date.now() - 60_000,
			user_id: "user-1",
		},
	});

	const { code } = await runCli(["me", "--profile", "stage"], {
		NEON_OAUTH_HOST: "http://127.0.0.1:9",
	});

	expect(code).toBe(0);
	expect(oauth.refreshAttempts()).toBe(1);
	expect(paths(profileApi)).toContain("GET /users/me");
});

describe("an unusable host in profiles.json", () => {
	test("fails a command that uses the profile, naming the field", async () => {
		writeConfig({
			"profiles.json": {
				version: 1,
				profiles: { stage: stageEntry({ apiHost: "console-stage" }) },
			},
		});

		const { code, stderr } = await runCli(["me", "--profile", "stage"]);

		expect(code).toBe(1);
		expect(stderr).toContain(
			'profile "stage" has an invalid `apiHost`: expected an http or https URL',
		);
	});

	test("on DEFAULT, fails a command that uses DEFAULT", async () => {
		writeConfig({
			"profiles.json": {
				version: 1,
				profiles: {
					DEFAULT: {
						credentials: "credentials.json",
						apiHost: profileApi.url,
					},
				},
			},
		});

		const { code, stderr } = await runCli(["me"]);

		expect(code).toBe(1);
		expect(stderr).toContain(
			'profile "DEFAULT" sets `apiHost`, which only a named profile can',
		);
	});
});
