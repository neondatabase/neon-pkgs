import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import type { AuthHttpError } from "./core/better-auth-helpers";
import { createAuthClient } from "./index";
import { BetterAuthReactAdapter } from "./react";
import { BetterAuthVanillaAdapter } from "./vanilla";

const BASE_URL = "https://auth.example.com";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Mirrors `getAuthErrorCode` and the `status` read in `getAuthErrorMessage` from
// `@better-auth-ui/core@1.7.30` (`lib/auth-error-message.ts`), where
// `body = asRecord(asRecord(error)?.error) ?? asRecord(error)`. The code comes
// from `body.code` and the status from `body.status ?? asRecord(error)?.status`.
// There is no top-level `.code` fallback when `.error` is an object; the
// top-level object is used only when `.error` is not an object. Re-check
// against the source on a better-auth-ui bump.
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function getAuthErrorCode(error: unknown): string | undefined {
	const body = asRecord(asRecord(error)?.error) ?? asRecord(error);
	return typeof body?.code === "string" ? body.code.toUpperCase() : undefined;
}

function getAuthErrorStatus(error: unknown): unknown {
	const body = asRecord(asRecord(error)?.error) ?? asRecord(error);
	return body?.status ?? asRecord(error)?.status;
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
	try {
		await fn();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to throw");
}

// better-auth-ui calls the client with `throw: true`.
const signInInput = {
	email: "a@b.co",
	password: "pw",
	fetchOptions: { throw: true as const },
};

const signInFns = {
	react: () =>
		createAuthClient(BASE_URL, {
			adapter: BetterAuthReactAdapter(),
		}).signIn.email(signInInput),
	vanilla: () =>
		createAuthClient(BASE_URL, {
			adapter: BetterAuthVanillaAdapter(),
		}).signIn.email(signInInput),
};

describe.each(
	Object.entries(signInFns),
)("raw Better Auth error body on thrown errors (%s adapter)", (_name, signIn) => {
	test("403 EMAIL_NOT_VERIFIED exposes error.code and keeps the Supabase-style code", async () => {
		server.use(
			http.post(`${BASE_URL}/api/auth/sign-in/email`, () =>
				HttpResponse.json(
					{
						code: "EMAIL_NOT_VERIFIED",
						message: "Email not verified",
					},
					{ status: 403, statusText: "Forbidden" },
				),
			),
		);

		const error = (await caught(signIn)) as AuthHttpError;

		expect(error.error).toMatchObject({
			code: "EMAIL_NOT_VERIFIED",
			message: "Email not verified",
		});
		expect(error.status).toBe(422);
		expect(error.statusText).toBe("Forbidden");
		expect(error.code).toBe("email_not_confirmed");
		expect(error).toBeInstanceOf(Error);
		expect(getAuthErrorCode(error)).toBe("EMAIL_NOT_VERIFIED");
		expect(getAuthErrorStatus(error)).toBe(403);
	});

	test("a raw { message } body gives better-auth-ui no code, so it falls back to the status message", async () => {
		server.use(
			http.post(`${BASE_URL}/api/auth/sign-in/email`, () =>
				HttpResponse.json(
					{ message: "Slow down" },
					{ status: 429, statusText: "Too Many Requests" },
				),
			),
		);

		const error = (await caught(signIn)) as AuthHttpError;

		expect(error.error).toEqual({ message: "Slow down", status: 429 });
		expect(getAuthErrorCode(error)).toBeUndefined();
		expect(getAuthErrorStatus(error)).toBe(429);
	});

	test("the HTTP status wins over a status carried in the response body", async () => {
		server.use(
			http.post(`${BASE_URL}/api/auth/sign-in/email`, () =>
				HttpResponse.json(
					{ message: "x", status: 400 },
					{ status: 429, statusText: "Too Many Requests" },
				),
			),
		);

		const error = (await caught(signIn)) as AuthHttpError;

		expect(error.error.status).toBe(429);
		expect(error.error.message).toBe("x");
	});

	test("401 INVALID_EMAIL_OR_PASSWORD exposes error.code", async () => {
		server.use(
			http.post(`${BASE_URL}/api/auth/sign-in/email`, () =>
				HttpResponse.json(
					{
						code: "INVALID_EMAIL_OR_PASSWORD",
						message: "Invalid email or password",
					},
					{ status: 401, statusText: "Unauthorized" },
				),
			),
		);

		const error = (await caught(signIn)) as AuthHttpError;

		expect(error.error).toMatchObject({
			code: "INVALID_EMAIL_OR_PASSWORD",
			message: "Invalid email or password",
		});
		expect(error.status).toBe(401);
		expect(error.statusText).toBe("Unauthorized");
		expect(error.code).toBe("invalid_credentials");
		expect(getAuthErrorCode(error)).toBe("INVALID_EMAIL_OR_PASSWORD");
	});
});
