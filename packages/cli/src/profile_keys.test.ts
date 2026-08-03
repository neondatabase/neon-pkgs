import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	identityFromAuthDetails,
	isApiKeyMethod,
	isGroupOrWorldReadable,
	mintedKeyName,
	notAnApiKeyMessage,
	readApiKeyFile,
} from "./profile_keys.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

function makeFile(name: string, contents: string): string {
	const root = mkdtempSync(join(tmpdir(), "neon-profile-keys-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const path = resolve(root, name);
	writeFileSync(path, contents);
	return path;
}

describe("mintedKeyName", () => {
	test("carries the profile, a UTC timestamp, and a suffix", () => {
		expect(
			mintedKeyName("dbx", new Date("2026-08-03T09:41:02.500Z"), "a3f1"),
		).toBe("neon-cli-dbx-20260803T094102Z-a3f1");
	});

	// Names are unique per account and the key being replaced still holds its name while the
	// replacement is minted, so a stable name fails rotation outright.
	test("two rotations a second apart do not collide", () => {
		expect(mintedKeyName("dbx", new Date("2026-08-03T09:41:02Z"))).not.toBe(
			mintedKeyName("dbx", new Date("2026-08-03T09:41:03Z")),
		);
	});

	test("different profiles get different names at the same instant", () => {
		const now = new Date("2026-08-03T09:41:02Z");
		expect(mintedKeyName("dbx", now)).not.toBe(
			mintedKeyName("personal", now),
		);
	});

	// The bug this suffix exists for: at second precision, two rotations in the same second
	// produced the same name and the API rejected the second one.
	test("two rotations in the same second do not collide", () => {
		const now = new Date("2026-08-03T09:41:02Z");
		const names = new Set(
			Array.from({ length: 50 }, () => mintedKeyName("dbx", now)),
		);
		expect(names.size).toBeGreaterThan(45);
	});

	test("the generated suffix is hex and does not need escaping", () => {
		expect(mintedKeyName("dbx", new Date("2026-08-03T09:41:02Z"))).toMatch(
			/^neon-cli-dbx-20260803T094102Z-[0-9a-f]{4}$/,
		);
	});
});

describe("readApiKeyFile", () => {
	test("the whole trimmed contents are the key", () => {
		expect(readApiKeyFile(makeFile("k", "  napi_abc\n"))).toBe("napi_abc");
	});

	test("a missing file names the path", () => {
		expect(() => readApiKeyFile("/definitely/not/here")).toThrow(
			/No such file: \/definitely\/not\/here/,
		);
	});

	// Storing an empty string would produce a profile that cannot work and says nothing.
	test("an empty file is refused", () => {
		expect(() => readApiKeyFile(makeFile("k", "   \n"))).toThrow(
			/is empty/,
		);
	});
});

describe("isGroupOrWorldReadable", () => {
	test("false for an owner-only file", () => {
		const path = makeFile("k", "napi_abc");
		chmodSync(path, 0o600);
		expect(isGroupOrWorldReadable(path)).toBe(false);
	});

	test("true for a world-readable file", () => {
		const path = makeFile("k", "napi_abc");
		chmodSync(path, 0o644);
		expect(isGroupOrWorldReadable(path)).toBe(true);
	});

	test("true for a group-readable file", () => {
		const path = makeFile("k", "napi_abc");
		chmodSync(path, 0o640);
		expect(isGroupOrWorldReadable(path)).toBe(true);
	});

	test("a missing file is not reported as exposed", () => {
		expect(isGroupOrWorldReadable("/definitely/not/here")).toBe(false);
	});
});

describe("isApiKeyMethod", () => {
	test("recognises both key methods", () => {
		expect(isApiKeyMethod("api_key_user")).toBe(true);
		expect(isApiKeyMethod("api_key_org")).toBe(true);
	});

	// An OAuth access token authenticates, so it would appear to work and then expire with no
	// way to refresh it.
	test("rejects everything that is not a key", () => {
		expect(isApiKeyMethod("oauth")).toBe(false);
		expect(isApiKeyMethod("session_cookie")).toBe(false);
		expect(isApiKeyMethod("keycloak")).toBe(false);
	});

	test("the rejection message names the method it saw", () => {
		expect(notAnApiKeyMessage("oauth")).toMatch(/authenticates as "oauth"/);
	});
});

describe("identityFromAuthDetails", () => {
	test("a user key is labelled with its email", () => {
		expect(
			identityFromAuthDetails(
				{ account_id: "user-1", auth_method: "api_key_user" },
				"me@example.com",
			),
		).toEqual({ label: "me@example.com", userId: "user-1" });
	});

	test("a user key with no email falls back to the account id", () => {
		expect(
			identityFromAuthDetails({
				account_id: "user-1",
				auth_method: "api_key_user",
			}),
		).toEqual({ label: "user-1", userId: "user-1" });
	});

	// `GET /users/me` answers 404 for an organization key, so there is no email to ask for and
	// no user id to record. The id is returned bare: it already announces what it is through
	// its `org-` prefix, and repeating the word beside a Scope column that says the same thing
	// printed it twice.
	test("an organization key is labelled by its id, with no user id", () => {
		expect(
			identityFromAuthDetails({
				account_id: "org-1",
				auth_method: "api_key_org",
			}),
		).toEqual({ label: "org-1" });
	});
});
