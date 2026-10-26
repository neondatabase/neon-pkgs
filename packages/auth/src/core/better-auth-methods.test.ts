import { describe, expect, test } from "vitest";
import { deriveBetterAuthMethodFromUrl } from "./better-auth-methods";

describe("deriveBetterAuthMethodFromUrl", () => {
	test.each([
		["https://a.example.com/api/auth/token", "getSession"],
		["https://a.example.com/api/auth/get-session", "getSession"],
		["https://a.example.com/api/auth/token/anonymous", "anonymousToken"],
		["https://a.example.com/api/auth/sign-in/email", "signIn"],
	])("%s -> %s", (url, expected) => {
		expect(deriveBetterAuthMethodFromUrl(url)).toBe(expected);
	});

	test.each([
		"token",
		"consent",
		"continue",
		"public-client",
		"public-client-prelogin",
		"get-consent",
		"get-consents",
		"update-consent",
		"delete-consent",
		"introspect",
	])("/oauth2/%s is not a session method", (name) => {
		expect(
			deriveBetterAuthMethodFromUrl(
				`https://a.example.com/api/auth/oauth2/${name}`,
			),
		).toBeUndefined();
	});

	test("a host named oauth2 does not suppress classification", () => {
		expect(
			deriveBetterAuthMethodFromUrl(
				"https://oauth2.example.com/api/auth/token",
			),
		).toBe("getSession");
	});

	test("/oauth2/ in the query string does not suppress classification", () => {
		expect(
			deriveBetterAuthMethodFromUrl(
				"https://a.example.com/api/auth/token?next=/oauth2/x",
			),
		).toBe("getSession");
	});

	test.each([
		"https://a.example.com/api/auth/oauth2/token",
		"https://ep.example.com/oauth2/auth/oauth2/token",
		"https://a.example.com/api/auth/oauth2/client/rotate-secret",
		"https://a.example.com/api/auth/oauth2/end-session/confirm",
	])("%s is not a session method", (url) => {
		expect(deriveBetterAuthMethodFromUrl(url)).toBeUndefined();
	});

	test("a database named oauth2 does not suppress classification", () => {
		expect(
			deriveBetterAuthMethodFromUrl(
				"https://ep.example.com/oauth2/auth/get-session",
			),
		).toBe("getSession");
		expect(
			deriveBetterAuthMethodFromUrl(
				"https://ep.example.com/oauth2/auth/token",
			),
		).toBe("getSession");
	});

	test.each([
		["https://x.example.com/oauth2/sign-out", "signOut"],
		["https://x.example.com/oauth2/get-session", "getSession"],
	])("a base URL ending in /oauth2: %s -> %s", (url, expected) => {
		expect(deriveBetterAuthMethodFromUrl(url)).toBe(expected);
	});

	test("a trailing slash on an oauth2 endpoint is still not a session method", () => {
		expect(
			deriveBetterAuthMethodFromUrl(
				"https://a.example.com/api/auth/oauth2/token/",
			),
		).toBeUndefined();
	});
});
