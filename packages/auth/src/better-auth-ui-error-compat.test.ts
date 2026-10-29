import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createAuthClient } from "./index";
import { BetterAuthReactAdapter } from "./react";
import { BetterAuthVanillaAdapter } from "./vanilla";

const BASE_URL = "https://auth.example.com";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Mirrors `getAuthErrorCode` from `@better-auth-ui/core@1.7.30`
// (lib/auth-error-message.ts:22-25): the code is read from the Better Fetch
// error body (`error.error`) first, then from the error itself, and upper-cased.
function getAuthErrorCode(error: unknown): string | undefined {
	const asRecord = (v: unknown) =>
		typeof v === "object" && v !== null
			? (v as Record<string, unknown>)
			: undefined;
	const body = asRecord(asRecord(error)?.error) ?? asRecord(error);
	return typeof body?.code === "string" ? body.code.toUpperCase() : undefined;
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
	try {
		await fn();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to throw");
}

const adapters = {
	react: () => BetterAuthReactAdapter(),
	vanilla: () => BetterAuthVanillaAdapter(),
};

describe.each(
	Object.entries(adapters),
)("raw Better Auth error body on thrown errors (%s adapter)", (_name, makeAdapter) => {
	const signIn = () => {
		const auth = createAuthClient(BASE_URL, { adapter: makeAdapter() });
		// better-auth-ui calls the client with `throw: true`.
		return auth.signIn.email({
			email: "a@b.co",
			password: "pw",
			fetchOptions: { throw: true },
		});
	};

	test("403 EMAIL_NOT_VERIFIED exposes error.code and keeps the Supabase-style code", async () => {
		server.use(
			http.post(`${BASE_URL}/api/auth/sign-in/email`, () =>
				HttpResponse.json(
					{ code: "EMAIL_NOT_VERIFIED", message: "Email not verified" },
					{ status: 403, statusText: "Forbidden" },
				),
			),
		);

		const error = (await caught(signIn)) as Record<string, any>;

		expect(error.error).toMatchObject({
			code: "EMAIL_NOT_VERIFIED",
			message: "Email not verified",
		});
		expect(error.status).toBe(422);
		expect(error.statusText).toBe("Forbidden");
		expect(error.code).toBe("email_not_confirmed");
		expect(error).toBeInstanceOf(Error);
		expect(getAuthErrorCode(error)).toBe("EMAIL_NOT_VERIFIED");
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

		const error = (await caught(signIn)) as Record<string, any>;

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
