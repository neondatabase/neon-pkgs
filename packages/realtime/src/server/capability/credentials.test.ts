import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createLoginSource,
	createTokenReuse,
	parseDatabaseUrl,
	vercelOidcToken,
} from "./credentials.js";

const NOW_SECONDS = 1_767_225_600;
/** Assembled at runtime: secret scanners flag literal user:password@host URLs. */
function pgUrl(userinfo: string, rest: string, scheme = "postgresql"): string {
	return `${scheme}://${userinfo}@${rest}`;
}
const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

function jwt(payload: Record<string, unknown>): string {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.c2ln`;
}

afterEach(() => {
	vi.unstubAllEnvs();
	delete (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT];
});

describe("Realtime database URL", () => {
	it("reads the user, password and database", () => {
		expect(
			parseDatabaseUrl(
				pgUrl(
					"neondb_owner:test-password",
					"ep-a.us-east-2.aws.neon.tech/neondb?sslmode=require",
				),
			),
		).toEqual({
			user: "neondb_owner",
			password: "test-password",
			database: "neondb",
		});
	});

	it("accepts postgres:// and decodes percent-encoded parts", () => {
		expect(
			parseDatabaseUrl(
				pgUrl("neondb_owner:p%40ss%2Fword", "host/my%20db", "postgres"),
			),
		).toEqual({
			user: "neondb_owner",
			password: "p@ss/word",
			database: "my db",
		});
	});

	it("treats a missing password as empty", () => {
		expect(
			parseDatabaseUrl("postgresql://neondb_owner@host/neondb"),
		).toEqual({ user: "neondb_owner", password: "", database: "neondb" });
		expect(
			parseDatabaseUrl("postgresql://neondb_owner:@host/neondb"),
		).toEqual({ user: "neondb_owner", password: "", database: "neondb" });
	});

	it("lets query parameters override the userinfo, as libpq does", () => {
		expect(
			parseDatabaseUrl(
				"postgresql://ignored@host/ignored?user=neondb_owner&password=pw&dbname=app",
			),
		).toEqual({ user: "neondb_owner", password: "pw", database: "app" });
	});

	it("omits the database when the URL has none", () => {
		expect(parseDatabaseUrl(pgUrl("neondb_owner:pw", "host"))).toEqual({
			user: "neondb_owner",
			password: "pw",
		});
	});

	it.each([
		"not a url",
		"https://neondb_owner:test-password@host/neondb",
		pgUrl("neondb_owner:%E0%A4%A", "host/neondb"),
	])("rejects %s without echoing it", (databaseUrl) => {
		let message = "";
		try {
			parseDatabaseUrl(databaseUrl);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toMatch(/^Invalid Realtime databaseUrl/);
		expect(message).not.toContain("test-password");
		expect(message).not.toContain("%E0");
	});
});

describe("Realtime login", () => {
	it("sends the URL's user and password", async () => {
		const login = createLoginSource(
			parseDatabaseUrl(
				pgUrl("neondb_owner:test-password", "host/neondb"),
			),
			undefined,
		);
		await expect(login()).resolves.toEqual({
			user: "neondb_owner",
			credential: "test-password",
		});
	});

	it.each([
		pgUrl("app_user:pw", "host/neondb"),
		"postgresql://authenticator@host/neondb",
	])("explains that only neondb_owner is supported (%s)", (databaseUrl) => {
		expect(() =>
			createLoginSource(parseDatabaseUrl(databaseUrl), undefined),
		).toThrow(
			"Neon Realtime currently supports only the neondb_owner role",
		);
	});

	it("rejects a URL without a user", () => {
		expect(() =>
			createLoginSource(
				parseDatabaseUrl("postgresql://host/neondb"),
				undefined,
			),
		).toThrow("Invalid Realtime databaseUrl: it has no user");
	});

	it("uses the OIDC token when the password is empty", async () => {
		const token = jwt({ exp: NOW_SECONDS + 3_600 });
		const login = createLoginSource(
			parseDatabaseUrl("postgresql://neondb_owner@host/neondb"),
			() => token,
		);
		await expect(login()).resolves.toEqual({
			user: "neondb_owner",
			credential: token,
		});
	});

	it("refuses an oidcToken alongside a password", () => {
		expect(() =>
			createLoginSource(
				parseDatabaseUrl(pgUrl("neondb_owner:pw", "host/neondb")),
				() => "token",
			),
		).toThrow(
			"Realtime uses oidcToken only when databaseUrl has no password",
		);
	});

	it("requires oidcToken to be a function", () => {
		expect(() =>
			createLoginSource(
				parseDatabaseUrl("postgresql://neondb_owner@host/neondb"),
				"a-token" as unknown as () => string,
			),
		).toThrow("Realtime oidcToken must be a function");
	});

	it("never sends an empty credential", async () => {
		const login = createLoginSource(
			parseDatabaseUrl("postgresql://neondb_owner@host/neondb"),
			() => "",
		);
		await expect(login()).rejects.toThrow(
			"Realtime got an invalid OIDC token",
		);
	});

	it("rejects a password longer than the envelope allows", () => {
		expect(() =>
			createLoginSource(
				{ user: "neondb_owner", password: "x".repeat(16_385) },
				undefined,
			),
		).toThrow("Invalid Realtime databaseUrl password");
	});
});

describe("OIDC token reuse", () => {
	it("reuses a token until 60 seconds before it expires", async () => {
		let now = NOW_SECONDS * 1_000;
		const first = jwt({ exp: NOW_SECONDS + 600 });
		const second = jwt({ exp: NOW_SECONDS + 1_200 });
		const source = vi
			.fn<() => string>()
			.mockReturnValueOnce(first)
			.mockReturnValueOnce(second);
		const token = createTokenReuse(source, () => now);

		await expect(token()).resolves.toBe(first);
		now += 539_000;
		await expect(token()).resolves.toBe(first);
		expect(source).toHaveBeenCalledTimes(1);
		now += 1_000;
		await expect(token()).resolves.toBe(second);
		expect(source).toHaveBeenCalledTimes(2);
	});

	it("asks again every time for a token without exp", async () => {
		const source = vi.fn(() => "opaque-token");
		const token = createTokenReuse(source, () => NOW_SECONDS * 1_000);
		await token();
		await token();
		expect(source).toHaveBeenCalledTimes(2);
	});

	it("uses but does not keep a token that is already close to expiry", async () => {
		const nearlyExpired = jwt({ exp: NOW_SECONDS + 30 });
		const source = vi.fn(() => nearlyExpired);
		const token = createTokenReuse(source, () => NOW_SECONDS * 1_000);
		await expect(token()).resolves.toBe(nearlyExpired);
		await token();
		expect(source).toHaveBeenCalledTimes(2);
	});

	it("shares one request between concurrent callers", async () => {
		let release!: (value: string) => void;
		const source = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					release = resolve;
				}),
		);
		const token = createTokenReuse(source, () => NOW_SECONDS * 1_000);
		const pending = Promise.all([token(), token()]);
		await vi.waitFor(() => expect(source).toHaveBeenCalledOnce());
		release(jwt({ exp: NOW_SECONDS + 600 }));
		const [first, second] = await pending;
		expect(first).toBe(second);
		expect(source).toHaveBeenCalledTimes(1);
	});

	it("tries again after a source that throws synchronously", async () => {
		const failure = new Error("no token yet");
		const token = jwt({ exp: NOW_SECONDS + 600 });
		const source = vi
			.fn<() => string>()
			.mockImplementationOnce(() => {
				throw failure;
			})
			.mockReturnValueOnce(token);
		const reuse = createTokenReuse(source, () => NOW_SECONDS * 1_000);
		await expect(reuse()).rejects.toBe(failure);
		await expect(reuse()).resolves.toBe(token);
		expect(source).toHaveBeenCalledTimes(2);
	});

	it("shares a synchronous failure with concurrent callers only", async () => {
		const failure = new Error("no token yet");
		const source = vi
			.fn<() => string>()
			.mockImplementationOnce(() => {
				throw failure;
			})
			.mockReturnValue("opaque-token");
		const reuse = createTokenReuse(source, () => NOW_SECONDS * 1_000);
		const [first, second] = await Promise.allSettled([reuse(), reuse()]);
		expect(first).toMatchObject({ status: "rejected", reason: failure });
		expect(second).toMatchObject({ status: "rejected", reason: failure });
		await expect(reuse()).resolves.toBe("opaque-token");
	});

	it("uses Vercel's token once it appears after a first failure", async () => {
		vi.stubEnv("VERCEL_OIDC_TOKEN", "");
		const login = createLoginSource(
			parseDatabaseUrl("postgresql://neondb_owner@host/neondb"),
			undefined,
		);
		await expect(login()).rejects.toThrow(
			"databaseUrl has no password, so Realtime sends a Vercel OIDC token",
		);
		vi.stubEnv("VERCEL_OIDC_TOKEN", "vercel-token-now-available");
		await expect(login()).resolves.toEqual({
			user: "neondb_owner",
			credential: "vercel-token-now-available",
		});
	});

	it("passes the source's error through and tries again next time", async () => {
		const failure = new Error("token service down");
		const source = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce(jwt({ exp: NOW_SECONDS + 600 }));
		const token = createTokenReuse(source, () => NOW_SECONDS * 1_000);
		await expect(token()).rejects.toBe(failure);
		await expect(token()).resolves.toEqual(expect.any(String));
	});
});

describe("Vercel OIDC token", () => {
	it("reads the request's x-vercel-oidc-token header first", () => {
		vi.stubEnv("VERCEL_OIDC_TOKEN", "from-env");
		(globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT] = {
			get: () => ({ headers: { "x-vercel-oidc-token": "from-request" } }),
		};
		expect(vercelOidcToken()).toBe("from-request");
	});

	it("falls back to VERCEL_OIDC_TOKEN", () => {
		vi.stubEnv("VERCEL_OIDC_TOKEN", "from-env");
		expect(vercelOidcToken()).toBe("from-env");
	});

	it("explains how to get a token when there is none", () => {
		vi.stubEnv("VERCEL_OIDC_TOKEN", "");
		expect(() => vercelOidcToken()).toThrow(
			"databaseUrl has no password, so Realtime sends a Vercel OIDC token, but none is available",
		);
	});
});
