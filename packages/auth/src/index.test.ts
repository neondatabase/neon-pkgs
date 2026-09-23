import { describe, expect, test } from "vitest";
import { AuthApiError, AuthError, isAuthApiError, isAuthError } from "./index";

// `llms.txt` documents `import { AuthError, AuthApiError } from
// '@neon/auth'` and `instanceof AuthApiError` as the supported
// narrowing API. These tests enforce that the root public entrypoint exports
// those symbols (plus their type guards) and that they behave as documented.
describe("@neon/auth root exports (error surface)", () => {
	test("AuthError and AuthApiError are exported as classes", () => {
		expect(typeof AuthError).toBe("function");
		expect(typeof AuthApiError).toBe("function");
	});

	test("AuthApiError is a subclass of AuthError / Error (for instanceof narrowing)", () => {
		const apiErr = new AuthApiError("nope", 401, "bad_jwt");
		expect(apiErr).toBeInstanceOf(AuthApiError);
		expect(apiErr).toBeInstanceOf(AuthError);
		expect(apiErr).toBeInstanceOf(Error);
	});

	test("AuthError is a subclass of Error (for instanceof narrowing)", () => {
		const err = new AuthError("nope", 500, "unexpected_failure");
		expect(err).toBeInstanceOf(AuthError);
		expect(err).toBeInstanceOf(Error);
	});

	test("isAuthError type guard matches AuthError instances", () => {
		expect(typeof isAuthError).toBe("function");
		expect(isAuthError(new AuthError("x", 500, "unexpected_failure"))).toBe(
			true,
		);
		expect(isAuthError(new AuthApiError("x", 401, "bad_jwt"))).toBe(true);
		expect(isAuthError(new Error("x"))).toBe(false);
		expect(isAuthError(null)).toBe(false);
	});

	test("isAuthApiError type guard matches only AuthApiError instances", () => {
		expect(typeof isAuthApiError).toBe("function");
		expect(isAuthApiError(new AuthApiError("x", 401, "bad_jwt"))).toBe(
			true,
		);
		// AuthError-but-not-AuthApiError should not be matched.
		expect(
			isAuthApiError(new AuthError("x", 500, "unexpected_failure")),
		).toBe(false);
		expect(isAuthApiError(new Error("x"))).toBe(false);
		expect(isAuthApiError(null)).toBe(false);
	});
});
