import { describe, expect, test } from "vitest";
import {
	DEFAULT_AUTH_SKIP_ROUTES,
	shouldProtectRoute,
} from "./route-protection";

describe("DEFAULT_AUTH_SKIP_ROUTES", () => {
	test("keeps the entries used by @neondatabase/auth-ui", () => {
		expect([...DEFAULT_AUTH_SKIP_ROUTES]).toEqual(
			expect.arrayContaining([
				"/api/auth",
				"/auth/callback",
				"/auth/sign-in",
				"/auth/sign-up",
				"/auth/magic-link",
				"/auth/email-otp",
				"/auth/forgot-password",
			]),
		);
	});

	// Auth views of @better-auth-ui/core@1.7.30 that a signed-out user must be
	// able to open: `viewPaths.auth` under the default "/auth" base path, plus the
	// default auth view paths of its magic-link, email-otp, two-factor,
	// phone-number and organization (accept-invitation) plugins. The list is a
	// hand-kept fixture because the package's required peer dependencies make it
	// impractical to install here; regenerate it from those sources when
	// bumping @better-auth-ui/core.
	const betterAuthUiPublicViews = [
		"callback",
		"error",
		"redirect",
		"sign-in",
		"sign-up",
		"forgot-password",
		"reset-password",
		"reset-link-sent",
		"sign-out",
		"verify-email",
		"magic-link",
		"magic-link-sent",
		"email-otp",
		"two-factor",
		"phone-number",
		"phone-number-forgot-password",
		"phone-number-reset-password",
		"accept-invitation",
	];

	test.each(betterAuthUiPublicViews)("does not protect /auth/%s", (view) => {
		expect(
			shouldProtectRoute(`/auth/${view}`, DEFAULT_AUTH_SKIP_ROUTES),
		).toBe(false);
	});

	test.each([
		"/settings",
		"/settings/account",
		"/settings/security",
		"/auth",
	])("still protects %s", (pathname) => {
		expect(shouldProtectRoute(pathname, DEFAULT_AUTH_SKIP_ROUTES)).toBe(
			true,
		);
	});
});

describe("shouldProtectRoute", () => {
	// Item 4 from #161 review (Andras): the matcher used bare `startsWith`
	// until this commit, which caused prefix bleed — `/auth/sign-in` would
	// also skip `/auth/sign-internal`, and `/api/auth` would skip
	// `/api/authz`. These tests pin the segment-aware behavior so the
	// regression can't sneak back in.

	describe("returns true (protect) when no skip route matches", () => {
		test.each([
			["/dashboard"],
			["/"],
			["/api/notes"],
			["/profile/settings"],
		])("%s", (pathname) => {
			expect(shouldProtectRoute(pathname, DEFAULT_AUTH_SKIP_ROUTES)).toBe(
				true,
			);
		});
	});

	describe("returns false (skip) for exact skip-route match", () => {
		test.each(
			DEFAULT_AUTH_SKIP_ROUTES.map((r) => [r] as const),
		)("%s", (pathname) => {
			expect(shouldProtectRoute(pathname, DEFAULT_AUTH_SKIP_ROUTES)).toBe(
				false,
			);
		});
	});

	describe("returns false (skip) for descendants of skip routes", () => {
		test.each([
			["/api/auth/sign-in/email"],
			["/api/auth/get-session"],
			["/auth/sign-in/"],
			["/auth/callback/google"],
		])("%s", (pathname) => {
			expect(shouldProtectRoute(pathname, DEFAULT_AUTH_SKIP_ROUTES)).toBe(
				false,
			);
		});
	});

	describe("rejects prefix-bleed siblings (regression guard for Andras #161)", () => {
		test.each([
			// Was: skipped because `/auth/sign-in`.startsWith match → undefined behavior
			["/auth/sign-internal"],
			// Was: skipped because `/api/auth`.startsWith match
			["/api/authz"],
			["/api/authorize"],
			// Was: skipped because `/auth/callback`.startsWith match
			["/auth/callback-handler"],
			// The pre-fix matcher considered any pathname starting with the
			// route string as a skip; segment-aware matching MUST require a
			// boundary (end-of-string or `/`).
			["/auth/sign-uphill"],
			["/auth/forgot-password-recovery"],
		])("%s is protected", (pathname) => {
			expect(shouldProtectRoute(pathname, DEFAULT_AUTH_SKIP_ROUTES)).toBe(
				true,
			);
		});
	});

	describe("tolerates trailing slashes on the skip route definition", () => {
		test("exact match with trailing slash on route", () => {
			expect(shouldProtectRoute("/api/auth", ["/api/auth/"])).toBe(false);
		});

		test("descendant still matches", () => {
			expect(
				shouldProtectRoute("/api/auth/sign-in", ["/api/auth/"]),
			).toBe(false);
		});

		test("prefix-bleed still rejected", () => {
			expect(shouldProtectRoute("/api/authz", ["/api/auth/"])).toBe(true);
		});
	});

	test("empty skipRoutes protects everything", () => {
		expect(shouldProtectRoute("/api/auth", [])).toBe(true);
	});
});
