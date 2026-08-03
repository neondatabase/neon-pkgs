import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	API_KEY,
	apiKeyCredentials,
	credentialKind,
	describeScope,
	interpretCredentials,
	OAUTH,
	readCredentials,
	scopeOf,
	writeCredentials,
} from "./credentials.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

function makeDir(files: Record<string, string> = {}): string {
	const root = mkdtempSync(join(tmpdir(), "neon-credentials-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	for (const [name, contents] of Object.entries(files)) {
		writeFileSync(resolve(root, name), contents);
	}
	return root;
}

describe("credentialKind", () => {
	// Every file written before profiles held API keys has no `type`, and must stay OAuth.
	test("an absent type means oauth", () => {
		expect(credentialKind({ access_token: "t" }, "p")).toBe(OAUTH);
	});

	test("an explicit oauth type means oauth", () => {
		expect(credentialKind({ type: "oauth" }, "p")).toBe(OAUTH);
	});

	test("an api_key type means api_key, even with nothing else present", () => {
		expect(credentialKind({ type: "api_key" }, "p")).toBe(API_KEY);
	});

	// Falling back to oauth would send the user to a browser login that overwrites the
	// credential they were trying to fix.
	test("an unrecognised type throws and quotes what it found", () => {
		expect(() => credentialKind({ type: "keychain" }, "/c.json")).toThrow(
			/unrecognised "type": "keychain"/,
		);
		expect(() => credentialKind({ type: "keychain" }, "/c.json")).toThrow(
			/\/c\.json/,
		);
	});
});

describe("interpretCredentials", () => {
	test("an api_key file resolves to its key", () => {
		expect(
			interpretCredentials({ type: "api_key", api_key: "napi_x" }, "p"),
		).toEqual({ kind: API_KEY, apiKey: "napi_x" });
	});

	test("an oauth file resolves to oauth without exposing a key", () => {
		expect(interpretCredentials({ access_token: "t" }, "p")).toEqual({
			kind: OAUTH,
		});
	});

	test("an api_key file with no key is a hard error, not a fall back to oauth", () => {
		expect(() =>
			interpretCredentials(
				{ type: "api_key", access_token: "t" },
				"/c.json",
			),
		).toThrow(/no "api_key" value/);
	});

	test("an api_key file with a blank key is a hard error", () => {
		expect(() =>
			interpretCredentials(
				{ type: "api_key", api_key: "   " },
				"/c.json",
			),
		).toThrow(/no "api_key" value/);
	});

	test("a key is trimmed", () => {
		expect(
			interpretCredentials(
				{ type: "api_key", api_key: " napi_x\n" },
				"p",
			),
		).toEqual({ kind: API_KEY, apiKey: "napi_x" });
	});
});

describe("readCredentials", () => {
	test("a missing file is null", () => {
		const dir = makeDir();
		expect(readCredentials(resolve(dir, "nope.json"))).toBeNull();
	});

	// Recoverable by logging in again, so the callers treat it as "no credentials".
	test("an unparseable file is null rather than an error", () => {
		const dir = makeDir({ "credentials.json": "not json" });
		expect(readCredentials(resolve(dir, "credentials.json"))).toBeNull();
	});

	test("a JSON array is null, not a credentials object", () => {
		const dir = makeDir({ "credentials.json": "[1,2]" });
		expect(readCredentials(resolve(dir, "credentials.json"))).toBeNull();
	});

	test("unknown fields survive a read", () => {
		const dir = makeDir({
			"credentials.json": JSON.stringify({
				access_token: "t",
				id_token: "i",
			}),
		});
		expect(readCredentials(resolve(dir, "credentials.json"))).toEqual({
			access_token: "t",
			id_token: "i",
		});
	});
});

describe("writeCredentials", () => {
	test("writes owner-only", () => {
		const dir = makeDir();
		const path = resolve(dir, "credentials.json");
		writeCredentials(path, { type: "api_key", api_key: "napi_x" });
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	// The reason this goes through a rename: `writeFileSync`'s mode is ignored for a file that
	// already exists, so an install carrying a 0700 file from an older release would keep it
	// forever, and one created under a loose umask would stay group-readable.
	test("repairs the permissions of a file that already exists", () => {
		const dir = makeDir({ "credentials.json": "{}" });
		const path = resolve(dir, "credentials.json");
		chmodSync(path, 0o744);
		expect(statSync(path).mode & 0o777).toBe(0o744);

		writeCredentials(path, { type: "api_key", api_key: "napi_x" });

		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("round-trips through readCredentials", () => {
		const dir = makeDir();
		const path = resolve(dir, "credentials.json");
		writeCredentials(path, {
			type: "api_key",
			api_key: "napi_x",
			key_id: 7,
		});
		expect(readCredentials(path)).toEqual({
			type: "api_key",
			api_key: "napi_x",
			key_id: 7,
		});
	});

	test("leaves no temporary file behind", () => {
		const dir = makeDir();
		writeCredentials(resolve(dir, "credentials.json"), { type: "oauth" });
		expect(require("node:fs").readdirSync(dir)).toEqual([
			"credentials.json",
		]);
	});
});

describe("apiKeyCredentials", () => {
	test("the minimum is a declared kind and the key", () => {
		expect(apiKeyCredentials({ apiKey: "napi_x" })).toEqual({
			type: "api_key",
			api_key: "napi_x",
		});
	});

	// The scope is not recoverable from the secret, and `rotate-key` has to mint the
	// replacement on the same endpoint or it would silently widen what the profile reaches.
	test("records the scope a key was minted at", () => {
		expect(
			apiKeyCredentials({
				apiKey: "napi_x",
				keyId: 7,
				userId: "u-1",
				scope: { orgId: "org-1", projectId: "proj-1" },
			}),
		).toEqual({
			type: "api_key",
			api_key: "napi_x",
			key_id: 7,
			user_id: "u-1",
			org_id: "org-1",
			project_id: "proj-1",
		});
	});

	// Single-kind: nothing from a previous credential is carried over, so a profile can never
	// hold one account's session beside another account's key.
	test("carries nothing over from an OAuth credential", () => {
		const dir = makeDir({
			"credentials.json": JSON.stringify({
				type: "oauth",
				access_token: "at",
				refresh_token: "rt",
				user_id: "u-old",
			}),
		});
		const path = resolve(dir, "credentials.json");
		writeCredentials(path, apiKeyCredentials({ apiKey: "napi_x" }));

		expect(readCredentials(path)).toEqual({
			type: "api_key",
			api_key: "napi_x",
		});
		const raw = readFileSync(path, "utf8");
		expect(raw).not.toContain("access_token");
		expect(raw).not.toContain("refresh_token");
		expect(raw).not.toContain("u-old");
	});
});

describe("scopeOf / describeScope", () => {
	test("an account key has no scope", () => {
		expect(scopeOf({ type: "api_key", api_key: "k" })).toEqual({});
		expect(describeScope({})).toBe("account");
	});

	test("an org key reports its organization", () => {
		const scope = scopeOf({
			type: "api_key",
			api_key: "k",
			org_id: "org-1",
		});
		expect(scope).toEqual({ orgId: "org-1" });
		expect(describeScope(scope)).toBe("org org-1");
	});

	// The narrowest scope is the one worth naming, and the one a reader cares about.
	test("a project key reports the project rather than the org", () => {
		const scope = scopeOf({
			type: "api_key",
			api_key: "k",
			org_id: "org-1",
			project_id: "proj-1",
		});
		expect(scope).toEqual({ orgId: "org-1", projectId: "proj-1" });
		expect(describeScope(scope)).toBe("project proj-1");
	});

	// The value comes off disk, so it can be any JSON type whatever the declared shape says.
	test("a non-string scope field is ignored rather than trusted", () => {
		const dir = makeDir({
			"credentials.json": JSON.stringify({
				type: "api_key",
				api_key: "k",
				org_id: 7,
			}),
		});
		const stored = readCredentials(resolve(dir, "credentials.json"));
		expect(stored).not.toBeNull();
		expect(scopeOf(stored as NonNullable<typeof stored>)).toEqual({});
	});
});
