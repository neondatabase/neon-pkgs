import { describe, expect, test } from "vitest";
import {
	identityFromAuthDetails,
	isApiKeyMethod,
	mintedKeyName,
	notAnApiKeyMessage,
} from "./profile_keys.js";

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
