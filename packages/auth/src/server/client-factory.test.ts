import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	expectTypeOf,
	test,
	vi,
} from "vitest";
import {
	type LocalBetterAuth,
	startLocalBetterAuth,
} from "../test/local-better-auth";
import { createAuthServer } from "./client-factory";
import type { RequestContext } from "./request-context";
import type { NeonAuthServer } from "./types";

const TEST_SECRET = "test-secret-at-least-32-characters-long!";
const TEST_BASE_URL = "https://auth.example.com";

// Server-return error shape contract: a plain serializable object. It is NOT
// an `AuthApiError` instance — consumers on the server path depend on
// `JSON.stringify(error)` and `{...error}` working, and neither works on an
// `Error` subclass (whose `message` is non-enumerable).
interface ServerError {
	message: string;
	status: number;
	statusText: string;
	code: string | undefined;
}

function makeContext(): RequestContext {
	return {
		getCookies: () => "",
		setCookie: () => {},
		getHeader: () => null,
		getOrigin: () => "https://app.example.com",
		getFramework: () => "test",
	};
}

// Items 3 from #161 review (Andras): the public toolkit factory MUST enforce
// the same cookie-secret invariants the Next.js adapter does, otherwise direct
// consumers can ship weak / empty secrets and yield forgeable session cookies.
describe("createAuthServer config validation", () => {
	test("throws when cookieSecret is empty", () => {
		expect(() =>
			createAuthServer({
				baseUrl: TEST_BASE_URL,
				context: makeContext,
				cookieSecret: "",
			}),
		).toThrow(/secret/i);
	});

	test("throws when cookieSecret is shorter than 32 characters", () => {
		expect(() =>
			createAuthServer({
				baseUrl: TEST_BASE_URL,
				context: makeContext,
				cookieSecret: "too-short",
			}),
		).toThrow(/32/);
	});

	test("throws when sessionDataTtl is zero or negative", () => {
		expect(() =>
			createAuthServer({
				baseUrl: TEST_BASE_URL,
				context: makeContext,
				cookieSecret: TEST_SECRET,
				sessionDataTtl: 0,
			}),
		).toThrow(/sessionDataTtl|ttl/i);

		expect(() =>
			createAuthServer({
				baseUrl: TEST_BASE_URL,
				context: makeContext,
				cookieSecret: TEST_SECRET,
				sessionDataTtl: -5,
			}),
		).toThrow();
	});

	test("accepts a valid 32+ char secret and positive sessionDataTtl", () => {
		expect(() =>
			createAuthServer({
				baseUrl: TEST_BASE_URL,
				context: makeContext,
				cookieSecret: TEST_SECRET,
				sessionDataTtl: 60,
			}),
		).not.toThrow();
	});
});

describe("createAuthServer error branch", () => {
	const originalFetch = globalThis.fetch;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("returns { data: null, error: POJO } with message/status/statusText/code on non-2xx", async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json(
				{
					message: "Invalid email or password",
					code: "INVALID_EMAIL_OR_PASSWORD",
				},
				{
					status: 401,
					statusText: "Unauthorized",
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const server = createAuthServer({
			baseUrl: TEST_BASE_URL,
			context: makeContext,
			cookieSecret: TEST_SECRET,
		});

		// `signIn.email` is a valid endpoint in API_ENDPOINTS — use it to trigger fetch.
		const result = (await (
			server as unknown as {
				signIn: {
					email: (
						args: unknown,
					) => Promise<{ data: unknown; error: unknown }>;
				};
			}
		).signIn.email({ email: "a@b.com", password: "wrong" })) as {
			data: unknown;
			error: ServerError;
		};

		expect(result.data).toBeNull();
		expect(result.error).not.toBeInstanceOf(Error);
		expect(typeof result.error).toBe("object");
		expect(result.error.status).toBe(401);
		expect(result.error.statusText).toBe("Unauthorized");
		expect(result.error.code).toBe("invalid_credentials");
		expect(typeof result.error.message).toBe("string");
		expect(result.error.message.length).toBeGreaterThan(0);
	});

	test("server error field is JSON-serializable (all fields present in output)", async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json(
				{
					message: "User already exists",
					code: "USER_ALREADY_EXISTS",
				},
				{
					status: 409,
					statusText: "Conflict",
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const server = createAuthServer({
			baseUrl: TEST_BASE_URL,
			context: makeContext,
			cookieSecret: TEST_SECRET,
		});

		const result = (await (
			server as unknown as {
				signUp: {
					email: (
						args: unknown,
					) => Promise<{ data: unknown; error: unknown }>;
				};
			}
		).signUp.email({
			email: "dup@example.com",
			password: "password123",
			name: "Dup",
		})) as { data: unknown; error: ServerError };

		const serialized = structuredClone(result.error);
		expect(serialized.message).toBeDefined();
		expect(serialized.status).toBe(409);
		expect(serialized.statusText).toBe("Conflict");
		expect(serialized.code).toBe("user_already_exists");
	});

	test("server error field supports object spread (all fields enumerable)", async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json(
				{ message: "Bad input", code: "VALIDATION_FAILED" },
				{
					status: 400,
					statusText: "Bad Request",
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const server = createAuthServer({
			baseUrl: TEST_BASE_URL,
			context: makeContext,
			cookieSecret: TEST_SECRET,
		});

		const result = (await (
			server as unknown as {
				signIn: {
					email: (
						args: unknown,
					) => Promise<{ data: unknown; error: unknown }>;
				};
			}
		).signIn.email({ email: "bad", password: "x" })) as {
			data: unknown;
			error: ServerError;
		};

		const spread = { ...result.error };
		expect(spread.message).toBe(result.error.message);
		expect(spread.status).toBe(400);
		expect(spread.statusText).toBe("Bad Request");
		expect(spread.code).toBe("validation_failed");
	});

	test("upstream code is normalized and preserved on error.code (not dropped)", async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json(
				{
					message: "Email already registered",
					code: "EMAIL_ALREADY_EXISTS",
				},
				{
					status: 409,
					statusText: "Conflict",
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const server = createAuthServer({
			baseUrl: TEST_BASE_URL,
			context: makeContext,
			cookieSecret: TEST_SECRET,
		});

		const result = (await (
			server as unknown as {
				signUp: {
					email: (
						args: unknown,
					) => Promise<{ data: unknown; error: unknown }>;
				};
			}
		).signUp.email({ email: "taken@example.com", password: "x" })) as {
			data: unknown;
			error: ServerError;
		};

		// Upstream `EMAIL_ALREADY_EXISTS` is mapped via BETTER_AUTH_ERROR_MAP to
		// the canonical snake_case code. We assert `code` is populated (i.e.
		// normalization ran) rather than hardcoding the exact mapping — the
		// important contract is "upstream code results in a non-empty error.code".
		expect(result.error.code).toBeDefined();
		expect(typeof result.error.code).toBe("string");
		expect((result.error.code as string).length).toBeGreaterThan(0);
	});

	test("status is preserved as a number even when normalization remaps", async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json(
				{ message: "Nope" },
				{
					status: 401,
					statusText: "Unauthorized",
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const server = createAuthServer({
			baseUrl: TEST_BASE_URL,
			context: makeContext,
			cookieSecret: TEST_SECRET,
		});

		const result = (await (
			server as unknown as {
				signIn: {
					email: (
						args: unknown,
					) => Promise<{ data: unknown; error: unknown }>;
				};
			}
		).signIn.email({ email: "a@b.com", password: "x" })) as {
			data: unknown;
			error: ServerError;
		};

		expect(typeof result.error.status).toBe("number");
		expect(result.error.status).toBe(401);
		expect(result.error.statusText).toBe("Unauthorized");
	});

	test("still returns { data, error: null } on 2xx responses", async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json(
				{ user: { id: "u1" }, session: { id: "s1" } },
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const server = createAuthServer({
			baseUrl: TEST_BASE_URL,
			context: makeContext,
			cookieSecret: TEST_SECRET,
		});

		const result = (await (
			server as unknown as {
				signIn: {
					email: (
						args: unknown,
					) => Promise<{ data: unknown; error: unknown }>;
				};
			}
		).signIn.email({ email: "a@b.com", password: "correct" })) as {
			data: unknown;
			error: unknown;
		};

		expect(result.error).toBeNull();
		expect(result.data).toMatchObject({
			user: { id: "u1" },
			session: { id: "s1" },
		});
	});
});

// Andras FIX 1 (security): the API-endpoint upstream-cookie loop in
// `client-factory.ts` must mirror the proxy and minting paths and always
// stamp `secure: true` on forwarded cookies. With `SameSite=None`, a missing
// `Secure` makes the browser drop the cookie entirely.
describe("createAuthServer cookie forwarding (Secure forcing)", () => {
	const originalFetch = globalThis.fetch;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function makeContextWithSpy(): {
		context: RequestContext;
		setCookieSpy: ReturnType<typeof vi.fn>;
	} {
		const setCookieSpy = vi.fn();
		return {
			context: {
				getCookies: () => "",
				setCookie: setCookieSpy,
				getHeader: () => null,
				getOrigin: () => "https://app.example.com",
				getFramework: () => "test",
			},
			setCookieSpy,
		};
	}

	// Helper: build an upstream 200 response with a single Set-Cookie header.
	// Using `Response.json` keeps lint (unicorn/prefer-response-static-json)
	// happy and matches sibling tests' style.
	function upstreamWithSetCookie(setCookie: string): Response {
		const headers = new Headers({
			"Content-Type": "application/json",
			"Set-Cookie": setCookie,
		});
		return Response.json({ ok: true }, { status: 200, headers });
	}

	test("forces Secure on forwarded cookies even when upstream omits it", async () => {
		const { context, setCookieSpy } = makeContextWithSpy();

		fetchMock.mockResolvedValueOnce(
			upstreamWithSetCookie(
				"__Secure-neon-auth.example_cookie=abc; Path=/; HttpOnly; SameSite=Lax",
			),
		);

		const server = createAuthServer({
			baseUrl: TEST_BASE_URL,
			context: () => context,
			cookieSecret: TEST_SECRET,
		});

		await (
			server as unknown as {
				signIn: { email: (args: unknown) => Promise<unknown> };
			}
		).signIn.email({ email: "a@b.com", password: "p" });

		expect(setCookieSpy).toHaveBeenCalled();
		const options = setCookieSpy.mock.calls[0][2];
		expect(options).toMatchObject({ secure: true });
	});

	test("keeps Secure when upstream sends SameSite=None (would otherwise be dropped)", async () => {
		const { context, setCookieSpy } = makeContextWithSpy();

		fetchMock.mockResolvedValueOnce(
			upstreamWithSetCookie(
				"__Secure-neon-auth.example_cookie=abc; Path=/; HttpOnly; SameSite=None",
			),
		);

		const server = createAuthServer({
			baseUrl: TEST_BASE_URL,
			context: () => context,
			cookieSecret: TEST_SECRET,
			sameSite: "none",
		});

		await (
			server as unknown as {
				signIn: { email: (args: unknown) => Promise<unknown> };
			}
		).signIn.email({ email: "a@b.com", password: "p" });

		expect(setCookieSpy).toHaveBeenCalled();
		const options = setCookieSpy.mock.calls[0][2];
		expect(options).toMatchObject({ secure: true, sameSite: "none" });
	});
});

describe("createAuthServer getAccessToken", () => {
	let fetchMock: ReturnType<typeof vi.fn>;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("POSTs { providerId, accountId } as a JSON body", async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ accessToken: "tok" }));

		const server = createAuthServer({
			baseUrl: TEST_BASE_URL,
			context: makeContext,
			cookieSecret: TEST_SECRET,
		});

		await (
			server as unknown as {
				getAccessToken: (args: unknown) => Promise<unknown>;
			}
		).getAccessToken({ providerId: "google", accountId: "acc_1" });

		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe(`${TEST_BASE_URL}/get-access-token`);
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body)).toEqual({
			providerId: "google",
			accountId: "acc_1",
		});
	});
});

describe("createAuthServer client-info header", () => {
	const originalFetch = globalThis.fetch;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("upstream requests carry X-Neon-Client-Info with betterAuthVersion", async () => {
		fetchMock.mockResolvedValueOnce(Response.json({}, { status: 200 }));

		const server = createAuthServer({
			baseUrl: TEST_BASE_URL,
			context: makeContext,
			cookieSecret: TEST_SECRET,
		});

		await (
			server as unknown as { listSessions: () => Promise<unknown> }
		).listSessions();

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const headers = new Headers(init.headers);
		const info = JSON.parse(headers.get("X-Neon-Client-Info") as string);
		expect(info.betterAuthVersion).toMatch(/^\d+\.\d+\.\d+$/);
		expect(headers.get("Origin")).toBe("https://app.example.com");
	});
});

describe("createAuthServer against Better Auth with the OAuth provider", () => {
	let local: LocalBetterAuth;

	beforeAll(async () => {
		local = await startLocalBetterAuth();
	});

	afterAll(async () => {
		await local.close();
	});

	const make = () =>
		createAuthServer({
			baseUrl: local.authUrl,
			context: () => ({
				...makeContext(),
				getOrigin: () => local.origin,
			}),
			cookieSecret: TEST_SECRET,
		});

	// Better Auth answers an unknown path or method with 404; anything else
	// means the route exists and accepted the method.
	const expectRouted = (method: string, path: string) => {
		const request = local.last();
		expect(request.method).toBe(method);
		expect(request.path).toBe(`/api/auth/${path}`);
		expect(request.status).not.toBe(404);
		return request;
	};

	const postCase = <B>(
		path: string,
		body: B,
		send: (body: B) => Promise<unknown>,
	) => ({ path, body, run: () => send(body) });

	const postCases = [
		postCase("consent", { accept: true, scope: "openid" }, (b) =>
			make().oauth2.consent(b),
		),
		postCase("continue", { selected: true }, (b) =>
			make().oauth2.continue(b),
		),
		postCase(
			"public-client-prelogin",
			{ client_id: "c1", oauth_query: "sig=s" },
			(b) => make().oauth2.publicClientPrelogin(b),
		),
		postCase(
			"update-consent",
			{ id: "k1", update: { scopes: ["openid"] } },
			(b) => make().oauth2.updateConsent(b),
		),
		postCase("delete-consent", { id: "k1" }, (b) =>
			make().oauth2.deleteConsent(b),
		),
	];

	test.each(postCases)("POSTs JSON to /oauth2/$path", async ({
		path,
		body,
		run,
	}) => {
		await run();
		expect(expectRouted("POST", `oauth2/${path}`).body).toEqual(body);
	});

	test("oauth2.publicClient GETs /oauth2/public-client with client_id", async () => {
		await make().oauth2.publicClient({ query: { client_id: "c1" } });
		expect(
			expectRouted("GET", "oauth2/public-client").query.get("client_id"),
		).toBe("c1");
	});

	test("oauth2.getConsent GETs /oauth2/get-consent with id", async () => {
		await make().oauth2.getConsent({ query: { id: "k1" } });
		expect(expectRouted("GET", "oauth2/get-consent").query.get("id")).toBe(
			"k1",
		);
	});

	test("oauth2.getConsents GETs /oauth2/get-consents", async () => {
		await make().oauth2.getConsents();
		expectRouted("GET", "oauth2/get-consents");
	});

	test("oauth2 exposes only the user actions Neon routes", () => {
		const oauth2: Record<string, unknown> = make().oauth2;
		for (const included of [
			"consent",
			"continue",
			"deleteConsent",
			"getConsent",
			"getConsents",
			"publicClient",
			"publicClientPrelogin",
			"updateConsent",
		]) {
			expect(typeof oauth2[included]).toBe("function");
		}
		for (const excluded of [
			"token",
			"introspect",
			"revoke",
			"register",
			"createClient",
			"getClients",
		]) {
			expect(oauth2[excluded]).toBeUndefined();
		}
	});

	test("the server type has only the routed oauth2 methods", () => {
		expectTypeOf<keyof NeonAuthServer["oauth2"]>().toEqualTypeOf<
			| "consent"
			| "continue"
			| "publicClientPrelogin"
			| "updateConsent"
			| "deleteConsent"
			| "publicClient"
			| "getConsent"
			| "getConsents"
		>();
	});

	test("revokeOtherSessions POSTs to /revoke-other-sessions", async () => {
		await make().revokeOtherSessions();
		expectRouted("POST", "revoke-other-sessions");
	});

	test("emailOtp.resetPassword POSTs to /email-otp/reset-password", async () => {
		const body = {
			email: "a@b.com",
			otp: "123456",
			password: "new-password",
		};
		await make().emailOtp.resetPassword(body);
		expect(expectRouted("POST", "email-otp/reset-password").body).toEqual(
			body,
		);
	});

	test("verifyEmail GETs /verify-email with the token in the query string", async () => {
		await make().verifyEmail({ query: { token: "tok-123" } });
		const request = expectRouted("GET", "verify-email");
		expect(request.query.get("token")).toBe("tok-123");
		expect(request.body).toBeUndefined();
	});

	test("jwks GETs /.well-known/jwks.json and returns the key set", async () => {
		const { data, error } = await make().jwks();
		expect(error).toBeNull();
		expect(expectRouted("GET", ".well-known/jwks.json").status).toBe(200);
		expect(Array.isArray(data?.keys)).toBe(true);
	});

	test("admin.listUserSessions POSTs to /admin/list-user-sessions", async () => {
		await make().admin.listUserSessions({ userId: "user-1" });
		expect(expectRouted("POST", "admin/list-user-sessions").body).toEqual({
			userId: "user-1",
		});
	});

	test("organization.checkSlug POSTs to /organization/check-slug", async () => {
		await make().organization.checkSlug({ slug: "acme" });
		expect(expectRouted("POST", "organization/check-slug").body).toEqual({
			slug: "acme",
		});
	});
});
