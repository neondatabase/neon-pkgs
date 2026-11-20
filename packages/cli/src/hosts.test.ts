import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_API_HOST } from "./api.js";
import { DEFAULT_OAUTH_HOST, hostUpdateFor, invocationHosts } from "./hosts.js";

const STAGE_API = "https://console-stage.example/api/v2";
const STAGE_OAUTH = "https://oauth2-stage.example";
const ENV_API = "https://env.example/api/v2";
const FLAG_API = "https://flag.example/api/v2";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

const configDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "neon-hosts-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(
		join(dir, "profiles.json"),
		JSON.stringify({
			version: 1,
			profiles: {
				DEFAULT: { credentials: "credentials.json" },
				stage: {
					credentials: "credentials.stage.json",
					apiHost: STAGE_API,
					oauthHost: STAGE_OAUTH,
				},
				plain: { credentials: "credentials.plain.json" },
			},
		}),
	);
	return dir;
};

describe("invocationHosts", () => {
	test("without a named profile: NEON_API_HOST, else production", () => {
		const dir = configDir();
		expect(invocationHosts(["me", "--config-dir", dir], {})).toEqual({
			apiHost: DEFAULT_API_HOST,
			oauthHost: DEFAULT_OAUTH_HOST,
		});
		expect(
			invocationHosts(["me", "--config-dir", dir], {
				NEON_API_HOST: ENV_API,
			}).apiHost,
		).toBe(ENV_API);
	});

	test.each([
		["--profile", ["--profile", "stage"], {}],
		["NEON_PROFILE", [], { NEON_PROFILE: "stage" }],
	])("a profile selected by %s brings its hosts, over NEON_API_HOST", (_label, args, env) => {
		const dir = configDir();
		expect(
			invocationHosts(["me", "--config-dir", dir, ...args], {
				NEON_API_HOST: ENV_API,
				NEON_OAUTH_HOST: "https://env-oauth.example",
				...env,
			}),
		).toEqual({ apiHost: STAGE_API, oauthHost: STAGE_OAUTH });
	});

	test("a profile that records no host follows NEON_API_HOST", () => {
		const dir = configDir();
		expect(
			invocationHosts(["me", "--config-dir", dir, "--profile", "plain"], {
				NEON_API_HOST: ENV_API,
			}).apiHost,
		).toBe(ENV_API);
	});

	test("--api-host overrides the profile, for that host only", () => {
		const dir = configDir();
		expect(
			invocationHosts(
				[
					"me",
					"--config-dir",
					dir,
					"--profile",
					"stage",
					`--api-host=${FLAG_API}`,
				],
				{},
			),
		).toEqual({ apiHost: FLAG_API, oauthHost: STAGE_OAUTH });
	});

	test("an API key the invocation uses instead of the profile brings no profile hosts", () => {
		const dir = configDir();
		const args = ["me", "--config-dir", dir];
		expect(
			invocationHosts(args, {
				NEON_API_KEY: "napi_ambient",
				NEON_PROFILE: "stage",
			}).apiHost,
		).toBe(DEFAULT_API_HOST);
		expect(
			invocationHosts([...args, "--api-key", "napi_flag"], {
				NEON_PROFILE: "stage",
			}).apiHost,
		).toBe(DEFAULT_API_HOST);
	});

	test("arguments after -- are not read", () => {
		const dir = configDir();
		expect(
			invocationHosts(
				["psql", "--config-dir", dir, "--", "--profile", "stage"],
				{},
			).apiHost,
		).toBe(DEFAULT_API_HOST);
	});
});

describe("hostUpdateFor", () => {
	test("records typed flags, and the production URL removes the recorded host", () => {
		expect(
			hostUpdateFor("stage", [
				"--api-host",
				STAGE_API,
				"--oauth-host",
				`${DEFAULT_OAUTH_HOST}/`,
			]),
		).toEqual({ apiHost: STAGE_API, oauthHost: null });
	});

	test("records nothing without flags, and nothing for DEFAULT", () => {
		expect(hostUpdateFor("stage", [])).toEqual({});
		expect(hostUpdateFor("DEFAULT", ["--api-host", STAGE_API])).toEqual({});
	});

	test("refuses a host that is not an http or https URL", () => {
		expect(() =>
			hostUpdateFor("stage", ["--api-host", "console-stage.example"]),
		).toThrow("--api-host must be an http or https URL");
	});
});
