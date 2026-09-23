import { describe, expect, test } from "vitest";
import {
	DEFAULT_AUTH_SKIP_ROUTES,
	shouldProtectRoute,
} from "./route-protection";

describe("DEFAULT_AUTH_SKIP_ROUTES", () => {
	// Behavior pin: this list was historically inlined in
	// `packages/auth/src/next/server/middleware.ts` as `SKIP_ROUTES`. Promoting
	// it to a toolkit-level export MUST preserve order and entries exactly so
	// that the Next.js middleware skip behavior is byte-for-byte unchanged.
	// Any intentional addition/removal should be a deliberate change paired
	// with a CHANGELOG entry.
	test("preserves the legacy Next.js skip list verbatim", () => {
		expect([...DEFAULT_AUTH_SKIP_ROUTES]).toEqual([
			"/api/auth",
			"/auth/callback",
			"/auth/sign-in",
			"/auth/sign-up",
			"/auth/magic-link",
			"/auth/email-otp",
			"/auth/forgot-password",
		]);
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
