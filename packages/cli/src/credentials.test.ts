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
	credentialKind,
	interpretCredentials,
	mergeCredentials,
	OAUTH,
	readCredentials,
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

describe("mergeCredentials", () => {
	// Signing in turns the file into an OAuth credential, but a key_id from an earlier
	// rotation is the only handle on a key that is still live upstream.
	test("keeps existing fields the update does not mention", () => {
		expect(
			mergeCredentials(
				{ type: "api_key", api_key: "napi_x", key_id: 7 },
				{ type: "oauth", access_token: "t" },
			),
		).toEqual({
			type: "oauth",
			api_key: "napi_x",
			key_id: 7,
			access_token: "t",
		});
	});

	test("an undefined value in the update does not erase an existing field", () => {
		expect(
			mergeCredentials(
				{ type: "api_key", api_key: "napi_x", refresh_token: "r" },
				{ refresh_token: undefined },
			).refresh_token,
		).toBe("r");
	});

	// An imported key has no discoverable id, so a stale one must go rather than be left
	// pointing at a key a later rotation would revoke by mistake.
	test("dropped fields are removed from the written object", () => {
		const merged = mergeCredentials(
			{ type: "api_key", api_key: "old", key_id: 7 },
			{ api_key: "new" },
			["key_id"],
		);
		expect(merged).toEqual({ type: "api_key", api_key: "new" });
		expect("key_id" in merged).toBe(false);
	});

	test("a dropped field leaves no trace on disk", () => {
		const dir = makeDir();
		const path = resolve(dir, "credentials.json");
		writeCredentials(
			path,
			mergeCredentials({ key_id: 7 }, { api_key: "new" }, ["key_id"]),
		);
		expect(readFileSync(path, "utf8")).not.toContain("key_id");
	});

	test("merging onto nothing is just the update", () => {
		expect(
			mergeCredentials(null, { type: "api_key", api_key: "k" }),
		).toEqual({ type: "api_key", api_key: "k" });
	});
});
