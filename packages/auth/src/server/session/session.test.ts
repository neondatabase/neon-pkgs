import { describe, expect, test, vi } from "vitest";
import type {
	BetterAuthSession,
	BetterAuthUser,
} from "@/core/better-auth-types";
import { ERRORS } from "@/server/errors";
import type { RequireSessionData } from "@/server/types";
import {
	getSessionDataFromCookie,
	parseSessionData,
	signSessionDataCookie,
} from "./operations";
import { assertCookieSecret, validateSessionData } from "./validator";

const TEST_SECRET = "test-secret-at-least-32-characters-long!";
const TEST_USER_ID = "user-123";
const TEST_EMAIL = "test@example.com";

const createTestSessionData = (
	expiresAt: Date = new Date(Date.now() + 3_600_000),
): RequireSessionData => {
	return {
		session: {
			id: "session-123",
			userId: TEST_USER_ID,
			token: "opaque-token-abc",
			expiresAt,
			createdAt: new Date(),
			updatedAt: new Date(),
			ipAddress: "127.0.0.1",
			userAgent: "test-agent",
		} as BetterAuthSession,
		user: {
			id: TEST_USER_ID,
			email: TEST_EMAIL,
			emailVerified: true,
			name: "Test User",
			image: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as BetterAuthUser,
	};
};

describe("validateSessionData", () => {
	test("should validate valid session data", async () => {
		const sessionData = createTestSessionData();
		const cookie = await signSessionDataCookie(sessionData, TEST_SECRET);

		const result = await validateSessionData(cookie.value, TEST_SECRET);
		expect(result.valid).toBe(true);
		expect(result.payload).toBeDefined();
		expect(result.payload).toEqual(
			expect.objectContaining({
				session: expect.objectContaining({
					id: "session-123",
					token: "opaque-token-abc",
				}),
				user: expect.objectContaining({
					id: TEST_USER_ID,
					email: TEST_EMAIL,
				}),
			}),
		);
	});

	test("should reject session data with wrong secret", async () => {
		const sessionData = createTestSessionData();
		const cookie = await signSessionDataCookie(sessionData, TEST_SECRET);

		// Validate with different secret
		const wrongSecret = "wrong-secret-at-least-32-characters!";
		const result = await validateSessionData(cookie.value, wrongSecret);

		expect(result.valid).toBe(false);
		expect(result.error).toBeDefined();
	});

	test("should reject expired session data", async () => {
		const sessionData = createTestSessionData(
			new Date(Date.now() - 3_600_000),
		);
		const cookie = await signSessionDataCookie(sessionData, TEST_SECRET);

		const result = await validateSessionData(cookie.value, TEST_SECRET);

		expect(result.valid).toBe(false);
		expect(result.error).toContain("exp");
	});

	test("should reject tampered session data", async () => {
		const sessionData = createTestSessionData();
		const cookie = await signSessionDataCookie(sessionData, TEST_SECRET);

		const parts = cookie.value.split(".");
		// Flip a character in the MIDDLE of the payload, not the last.
		// Base64url's last char can have padding bits that don't affect decoded
		// output (1-in-16 chance of collision), causing flaky signature validation.
		// Middle chars are fully significant so flipping one always changes the bytes.
		const payload = parts[1];
		const mid = Math.floor(payload.length / 2);
		const flipped = payload[mid] === "A" ? "B" : "A";
		const tamperedPayload =
			payload.slice(0, mid) + flipped + payload.slice(mid + 1);
		const tamperedData = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

		const result = await validateSessionData(tamperedData, TEST_SECRET);

		expect(result.valid).toBe(false);
	});

	test("should reject non-JWT format strings", async () => {
		const result = await validateSessionData(
			"not-a-jwt-token",
			TEST_SECRET,
		);
		expect(result.valid).toBe(false);
		expect(result.error).toBeDefined();
	});

	test("should reject JWT with missing parts", async () => {
		const result = await validateSessionData("header.payload", TEST_SECRET); // Missing signature
		expect(result.valid).toBe(false);
		expect(result.error).toBeDefined();
	});

	test("should reject empty cookie value", async () => {
		const result = await validateSessionData("", TEST_SECRET);
		expect(result.valid).toBe(false);
		expect(result.error).toBeDefined();
	});
});

describe("signSessionDataCookie", () => {
	test("should convert session data to signed cookie", async () => {
		const sessionData = createTestSessionData();
		const result = await signSessionDataCookie(sessionData, TEST_SECRET);

		expect(result.value).toBeTypeOf("string");
		expect(result.expiresAt).toBeInstanceOf(Date);

		// Validate the session data
		const validation = await validateSessionData(result.value, TEST_SECRET);
		expect(validation.valid).toBe(true);
		expect(validation.payload?.user?.id).toBe(TEST_USER_ID);
		expect(validation.payload?.user?.email).toBe(TEST_EMAIL);
		expect(validation.payload?.session?.id).toBe("session-123");
		expect(validation.payload?.session?.token).toBe("opaque-token-abc");
	});

	test("should use 5-minute TTL or session expiry, whichever is sooner", async () => {
		const sessionData = createTestSessionData();
		sessionData.session.expiresAt = new Date(Date.now() + 7_200_000); // 2 hours

		const result = await signSessionDataCookie(sessionData, TEST_SECRET);

		// Should use 5-minute TTL, not session expiry
		const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;
		const timeDiff = Math.abs(
			result.expiresAt.getTime() - fiveMinutesFromNow,
		);

		// Allow 1 second tolerance
		expect(timeDiff).toBeLessThan(1000);
	});

	test("should handle session data with Date objects from API", async () => {
		const sessionData = createTestSessionData();

		// Ensure expiresAt is a Date object (as it should be after parsing)
		expect(sessionData.session.expiresAt).toBeInstanceOf(Date);
		expect(typeof sessionData.session.expiresAt.getTime).toBe("function");

		// Should successfully create signed cookie without throwing
		const result = await signSessionDataCookie(sessionData, TEST_SECRET);
		expect(result.value).toBeTypeOf("string");
		expect(result.expiresAt).toBeInstanceOf(Date);
	});

	test("should use session expiry when less than 5-minute TTL", async () => {
		const twoMinutesFromNow = new Date(Date.now() + 2 * 60 * 1000);
		const sessionData = createTestSessionData(twoMinutesFromNow);

		const result = await signSessionDataCookie(sessionData, TEST_SECRET);

		// Should use session expiry (2 min), not 5-min TTL
		const timeDiff = Math.abs(
			result.expiresAt.getTime() - twoMinutesFromNow.getTime(),
		);
		expect(timeDiff).toBeLessThan(1000); // 1 second tolerance
	});
});

describe("assertCookieSecret", () => {
	test("assertCookieSecret throws when no secret provided", () => {
		expect(() => assertCookieSecret()).toThrow(
			ERRORS.MISSING_COOKIE_SECRET,
		);
		expect(() => assertCookieSecret()).toThrow(
			ERRORS.MISSING_COOKIE_SECRET,
		);
	});

	test("assertCookieSecret uses provided secret instead of env", () => {
		const providedSecret = "provided-secret-at-least-32-chars!";
		expect(() => assertCookieSecret(providedSecret)).not.toThrow();
	});

	test("assertCookieSecret throws when provided secret is too short", () => {
		expect(() => assertCookieSecret("short")).toThrow(
			ERRORS.COOKIE_SECRET_TOO_SHORT,
		);
	});
});

describe("parseSessionData", () => {
	test("parses valid ISO date strings", () => {
		const json = {
			session: {
				id: "session-123",
				userId: "user-123",
				token: "token-abc",
				expiresAt: "2026-01-20T00:00:00.000Z", // ISO string
				createdAt: "2026-01-18T00:00:00.000Z",
				updatedAt: "2026-01-18T00:00:00.000Z",
				ipAddress: "127.0.0.1",
				userAgent: "test",
			},
			user: {
				id: "user-123",
				email: "test@example.com",
				emailVerified: true,
				name: "Test User",
				image: null,
				createdAt: "2026-01-18T00:00:00.000Z",
				updatedAt: "2026-01-18T00:00:00.000Z",
			},
		};

		const result = parseSessionData(json);
		expect(result.session?.expiresAt).toBeInstanceOf(Date);
		expect(result.session?.expiresAt.getTime()).toBeGreaterThan(0);
		expect(result.user?.createdAt).toBeInstanceOf(Date);
	});

	test("handles missing session/user gracefully", () => {
		const result = parseSessionData({});
		expect(result.session).toBe(null);
		expect(result.user).toBe(null);
	});

	test("handles null session in response", () => {
		const result = parseSessionData({ session: null, user: null });
		expect(result.session).toBe(null);
		expect(result.user).toBe(null);
	});

	test("returns null session on invalid date strings", () => {
		const json = {
			session: {
				id: "session-123",
				userId: "user-123",
				token: "token-abc",
				expiresAt: "not-a-date",
				createdAt: "2026-01-18T00:00:00.000Z",
				updatedAt: "2026-01-18T00:00:00.000Z",
				ipAddress: "127.0.0.1",
				userAgent: "test",
			},
			user: {
				id: "user-123",
				email: "test@example.com",
				emailVerified: true,
				name: "Test User",
				image: null,
				createdAt: "2026-01-18T00:00:00.000Z",
				updatedAt: "2026-01-18T00:00:00.000Z",
			},
		};

		// After error handling improvements, this should return null session
		const result = parseSessionData(json);
		expect(result.session).toBe(null);
		expect(result.user).toBe(null);
	});

	test("handles null/undefined input", () => {
		expect(parseSessionData(null)).toEqual({ session: null, user: null });
		expect(parseSessionData({})).toEqual({ session: null, user: null });
	});

	// Item 6 from #161 review (Andras): `parseSessionData` was writing to
	// `console.error` unconditionally on parse failure, bypassing the
	// package's own `logLevel: 'silent'` contract. These tests pin that
	// the injected logger is honored — and that no fallback `console.error`
	// call leaks when one is provided.
	describe("logger plumbing (Andras #161 item 6)", () => {
		test("uses the injected logger instead of console.error on parse failure", () => {
			const consoleErrorSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			const loggerErrorSpy = vi.fn();
			const log = {
				error: loggerErrorSpy,
				warn: vi.fn(),
				info: vi.fn(),
				debug: vi.fn(),
			};

			const badJson = {
				session: {
					id: "sess-123",
					userId: "user-123",
					expiresAt: "not-a-date",
					createdAt: "2026-01-18T00:00:00.000Z",
					updatedAt: "2026-01-18T00:00:00.000Z",
				},
				user: { id: "user-123", email: "a@b.com" },
			};

			const result = parseSessionData(badJson, log);

			expect(result).toEqual({ session: null, user: null });
			expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
			expect(loggerErrorSpy).toHaveBeenCalledWith(
				"[parseSessionData] Failed to parse session dates:",
				expect.objectContaining({
					error: expect.stringContaining("Invalid date"),
					hasSession: true,
					hasUser: true,
				}),
			);
			// Critical: NO console.error fallback when a logger was provided.
			expect(consoleErrorSpy).not.toHaveBeenCalled();

			consoleErrorSpy.mockRestore();
		});

		test("falls back to console.error when no logger is provided (back-compat)", () => {
			const consoleErrorSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});

			const badJson = {
				session: { id: "sess-1", expiresAt: "bad" },
				user: { id: "u-1" },
			};

			const result = parseSessionData(badJson);

			expect(result).toEqual({ session: null, user: null });
			expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[parseSessionData] Failed to parse session dates:",
				expect.any(Object),
			);

			consoleErrorSpy.mockRestore();
		});
	});
});

describe("getSessionDataFromCookie", () => {
	test("returns null when cookie header is missing", async () => {
		const request = new Request("https://example.com", {});
		const result = await getSessionDataFromCookie(
			request,
			"session_data",
			TEST_SECRET,
		);
		expect(result).toBe(null);
	});

	test("returns null when target cookie is not present", async () => {
		const request = new Request("https://example.com", {
			headers: { Cookie: "other_cookie=value" },
		});
		const result = await getSessionDataFromCookie(
			request,
			"session_data",
			TEST_SECRET,
		);
		expect(result).toBe(null);
	});

	test("extracts and validates session data from valid cookie", async () => {
		const sessionData = createTestSessionData();
		const cookie = await signSessionDataCookie(sessionData, TEST_SECRET);

		const request = new Request("https://example.com", {
			headers: { Cookie: `session_data=${cookie.value}` },
		});

		const result = await getSessionDataFromCookie(
			request,
			"session_data",
			TEST_SECRET,
		);
		expect(result).not.toBe(null);
		expect(result?.session?.id).toBe("session-123");
		expect(result?.user?.id).toBe(TEST_USER_ID);
	});

	test("returns null for invalid cookie signature", async () => {
		const request = new Request("https://example.com", {
			headers: { Cookie: "session_data=invalid.jwt.token" },
		});

		const result = await getSessionDataFromCookie(
			request,
			"session_data",
			TEST_SECRET,
		);
		expect(result).toBe(null);
	});

	test("handles multiple cookies in header", async () => {
		const sessionData = createTestSessionData();
		const cookie = await signSessionDataCookie(sessionData, TEST_SECRET);

		const request = new Request("https://example.com", {
			headers: {
				Cookie: `other=value; session_data=${cookie.value}; another=123`,
			},
		});

		const result = await getSessionDataFromCookie(
			request,
			"session_data",
			TEST_SECRET,
		);
		expect(result?.session?.id).toBe("session-123");
	});
});
