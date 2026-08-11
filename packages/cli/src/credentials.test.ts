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
import {
	API_KEY,
	apiKeyCredentials,
	credentialKind,
	describeScope,
	inspectCredentials,
	interpretCredentials,
	isSameCredential,
	OAUTH,
	readCredentials,
	scopeOf,
	writeCredentials,
} from "@neon-internals/cli-core/credentials";
import { afterEach, describe, expect, test } from "vitest";

/**
 * Where a credential lives and which profile points at it.
 *
 * Both halves travel together because every error these functions raise ends in a recovery
 * command, and that command takes the profile name.
 */
const at = (path: string, profile = "work") => ({ path, profile });

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
		expect(credentialKind({ access_token: "t" }, at("p"))).toBe(OAUTH);
	});

	test("an explicit oauth type means oauth", () => {
		expect(credentialKind({ type: "oauth" }, at("p"))).toBe(OAUTH);
	});

	test("an api_key type means api_key, even with nothing else present", () => {
		expect(credentialKind({ type: "api_key" }, at("p"))).toBe(API_KEY);
	});

	// Falling back to oauth would send the user to a browser login that overwrites the
	// credential they were trying to fix.
	test("an unrecognised type throws and quotes what it found", () => {
		expect(() =>
			credentialKind({ type: "keychain" }, at("/c.json")),
		).toThrow(/declares a "type" this version does not understand/);
		expect(() =>
			credentialKind({ type: "keychain" }, at("/c.json")),
		).toThrow(/\/c\.json/);
	});

	// This message used to be the one dead end among the credential errors: the unparseable
	// sibling appended a repair and this did not, because it throws before the reader that
	// adds one. A file the CLI refuses to authenticate with has to say how to get out of it.
	test("an unrecognised type says how to recover, naming the profile", () => {
		expect(() =>
			credentialKind({ type: "keychain" }, at("/c.json", "work")),
		).toThrow(/`neon profile create work --force`/);
	});
});

describe("interpretCredentials", () => {
	test("an api_key file resolves to its key", () => {
		expect(
			interpretCredentials(
				{ type: "api_key", api_key: "napi_x" },
				at("p"),
			),
		).toEqual({ kind: API_KEY, apiKey: "napi_x" });
	});

	test("an oauth file resolves to oauth without exposing a key", () => {
		expect(interpretCredentials({ access_token: "t" }, at("p"))).toEqual({
			kind: OAUTH,
		});
	});

	test("an api_key file with no key is a hard error, not a fall back to oauth", () => {
		expect(() =>
			interpretCredentials(
				{ type: "api_key", access_token: "t" },
				at("/c.json"),
			),
		).toThrow(/no "api_key" value/);
	});

	test("an api_key file with a blank key is a hard error", () => {
		expect(() =>
			interpretCredentials(
				{ type: "api_key", api_key: "   " },
				at("/c.json"),
			),
		).toThrow(/no "api_key" value/);
	});

	// The recovery command is only useful if it is runnable. Both of these printed a literal
	// `<name>`, which an agent runs verbatim and gets `Invalid profile name "<name>"` for.
	test("the recovery command names the profile rather than a placeholder", () => {
		expect(() =>
			interpretCredentials({ type: "api_key" }, at("/c.json", "dbx")),
		).toThrow(/`neon profile create dbx --force`/);
		expect(() =>
			interpretCredentials({ type: "api_key" }, at("/c.json", "dbx")),
		).not.toThrow(/<name>/);
	});

	test("a key is trimmed", () => {
		expect(
			interpretCredentials(
				{ type: "api_key", api_key: " napi_x\n" },
				at("p"),
			),
		).toEqual({ kind: API_KEY, apiKey: "napi_x" });
	});
});

describe("readCredentials", () => {
	test("a missing file is null", () => {
		const dir = makeDir();
		expect(readCredentials(at(resolve(dir, "nope.json")))).toBeNull();
	});

	// A damaged file is recoverable by signing in again, so it reads as "no credentials" — but
	// it is classified as damaged rather than absent, so the caller can say so out loud.
	test("an unparseable file is unusable, and says why", () => {
		const dir = makeDir({ "credentials.json": "not json" });
		const path = resolve(dir, "credentials.json");
		const read = inspectCredentials(path);
		expect(read.kind).toBe("unusable");
		expect(read.kind === "unusable" && read.reason).toContain(
			"not valid JSON",
		);
		expect(read.kind === "unusable" && read.reason).toContain(path);
		// Using it is an error: a read-only command must not "repair" it by signing in again,
		// which would overwrite it and possibly as a different account.
		expect(() => readCredentials(at(path))).toThrow(/not valid JSON/);
		expect(() => readCredentials(at(path, "dbx"))).toThrow(
			/Replace it deliberately with `neon profile create dbx --force`/,
		);
	});

	// V8 quotes a window of the input around a syntax error, so on Node 24 a truncated
	// credentials file produced `Unexpected token 'a', ..."api_key":napi_SUPERS"... is not
	// valid JSON` — and this reason is printed by `profile list` and by every failed
	// authentication. The one file guaranteed to hold a secret is the one whose parse errors
	// must say the least.
	test("a malformed file's reason never quotes its contents", () => {
		const secret = "napi_SENTINELSECRETVALUE";
		const dir = makeDir({
			"credentials.json": `{"type":"api_key","api_key":${secret}}`,
		});
		const path = resolve(dir, "credentials.json");

		const read = inspectCredentials(path);
		expect(read.kind).toBe("unusable");
		const reason = read.kind === "unusable" ? read.reason : "";
		expect(reason).toContain("not valid JSON");
		expect(reason).toContain(path);
		expect(reason).not.toContain("napi_");
		expect(reason).not.toContain(secret.slice(0, 10));

		// And through the fatal reader, which is what an authenticating command prints.
		let thrown = "";
		try {
			readCredentials(at(path));
		} catch (err) {
			thrown = err instanceof Error ? err.message : String(err);
		}
		expect(thrown).toContain("not valid JSON");
		expect(thrown).not.toContain("napi_");
	});

	// Same reasoning for a declared kind: it is a value read out of a secret file, and a
	// corrupted or hand-edited file can put key material in any field.
	test("an unrecognised type is not quoted back either", () => {
		let thrown = "";
		try {
			credentialKind(
				{ type: "napi_SENTINELSECRETVALUE" },
				at("/c.json", "work"),
			);
		} catch (err) {
			thrown = err instanceof Error ? err.message : String(err);
		}
		expect(thrown).toContain("does not understand");
		expect(thrown).toContain("/c.json");
		expect(thrown).toContain("`neon profile create work --force`");
		expect(thrown).not.toContain("napi_");
	});

	test("a JSON array is unusable, not a credentials object", () => {
		const dir = makeDir({ "credentials.json": "[1,2]" });
		const path = resolve(dir, "credentials.json");
		expect(inspectCredentials(path).kind).toBe("unusable");
		expect(() => readCredentials(at(path))).toThrow(
			/does not contain a credentials object/,
		);
	});

	test("a missing file is absent rather than damaged", () => {
		const dir = makeDir();
		expect(inspectCredentials(resolve(dir, "nope.json")).kind).toBe(
			"absent",
		);
	});

	// A permission error may be hiding a perfectly good credential, so it must not read as
	// absent and send the caller to a login that overwrites it.
	test("an unreadable file throws rather than reading as absent", () => {
		const dir = makeDir({ "credentials.json": "{}" });
		const path = resolve(dir, "credentials.json");
		chmodSync(path, 0o000);
		try {
			expect(() => readCredentials(at(path))).toThrow();
		} finally {
			chmodSync(path, 0o600);
		}
	});

	test("unknown fields survive a read", () => {
		const dir = makeDir({
			"credentials.json": JSON.stringify({
				access_token: "t",
				id_token: "i",
			}),
		});
		expect(readCredentials(at(resolve(dir, "credentials.json")))).toEqual({
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
		expect(readCredentials(at(path))).toEqual({
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

		expect(readCredentials(at(path))).toEqual({
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
		const stored = readCredentials(at(resolve(dir, "credentials.json")));
		expect(stored).not.toBeNull();
		expect(scopeOf(stored as NonNullable<typeof stored>)).toEqual({});
	});
});

describe("isSameCredential", () => {
	// Re-storing the key a profile already holds is a no-op. Without this the caller retires the
	// old credential and revokes the key it has just committed to.
	test("recognises the same key", () => {
		expect(isSameCredential("napi_same", "napi_same")).toBe(true);
	});

	// A key read from a file or a pipe arrives with a trailing newline.
	test("ignores surrounding whitespace on either side", () => {
		expect(isSameCredential(" napi_same\n", "napi_same")).toBe(true);
		expect(isSameCredential("napi_same", "  napi_same\n")).toBe(true);
	});

	test("a different key is a real replacement", () => {
		expect(isSameCredential("napi_old", "napi_new")).toBe(false);
	});

	// An empty stored key must not match an empty replacement and suppress a retirement.
	test("blank values never match", () => {
		expect(isSameCredential("  ", "  ")).toBe(false);
		expect(isSameCredential("napi_x", undefined)).toBe(false);
		expect(isSameCredential(undefined, "napi_x")).toBe(false);
	});
});
