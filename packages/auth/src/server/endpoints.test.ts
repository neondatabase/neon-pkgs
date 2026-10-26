import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin } from "better-auth/plugins/admin";
import { emailOTP } from "better-auth/plugins/email-otp";
import { jwt } from "better-auth/plugins/jwt";
import { magicLink } from "better-auth/plugins/magic-link";
import { organization } from "better-auth/plugins/organization";
import { phoneNumber } from "better-auth/plugins/phone-number";
import { describe, expect, test } from "vitest";
import {
	API_ENDPOINTS,
	type EndpointConfig,
	NEON_AUTH_JWKS_PATH,
} from "./endpoints";

type Method = string | readonly string[] | undefined;
interface RouteLike {
	path?: unknown;
	options?: { method?: Method };
}

function isRoute(value: unknown): value is RouteLike & { path: string } {
	return (
		typeof value === "function" &&
		typeof (value as RouteLike).path === "string" &&
		typeof (value as RouteLike).options === "object" &&
		(value as RouteLike).options !== null
	);
}

function collectRoutes(
	endpoints: Record<string, unknown>,
	into: Map<string, Set<string>>,
): void {
	for (const value of Object.values(endpoints)) {
		if (!isRoute(value)) continue;
		const raw = value.options?.method;
		let methods: string[] = [];
		if (Array.isArray(raw)) methods = raw;
		else if (raw) methods = [raw as string];
		const existing = into.get(value.path) ?? new Set<string>();
		for (const m of methods) existing.add(String(m).toUpperCase());
		into.set(value.path, existing);
	}
}

const noop = async () => {};
const auth = betterAuth({
	baseURL: "http://localhost",
	secret: "test-secret-at-least-32-characters-long!",
	database: memoryAdapter({}),
	emailAndPassword: { enabled: true },
	plugins: [
		admin(),
		organization(),
		emailOTP({ sendVerificationOTP: noop }),
		magicLink({ sendMagicLink: noop }),
		phoneNumber(),
		jwt({ jwks: { jwksPath: NEON_AUTH_JWKS_PATH } }),
		oauthProvider({ loginPage: "/login", consentPage: "/consent" }),
	],
});

const betterAuthRoutes = new Map<string, Set<string>>();
collectRoutes(auth.api as unknown as Record<string, unknown>, betterAuthRoutes);

// Routes served by Neon Auth that Better Auth does not define.
const NEON_SPECIFIC_ROUTES: Record<string, string[]> = {
	// Anonymous JWT for RLS access; see plugins/anonymous-token.ts.
	"/token/anonymous": ["GET"],
};

function isEndpointConfig(value: unknown): value is EndpointConfig {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as EndpointConfig).path === "string" &&
		typeof (value as EndpointConfig).method === "string"
	);
}

function leaves(
	tree: Record<string, unknown>,
	prefix = "",
): Array<[string, EndpointConfig]> {
	return Object.entries(tree).flatMap(([key, value]) => {
		const name = prefix ? `${prefix}.${key}` : key;
		if (isEndpointConfig(value))
			return [[name, value] as [string, EndpointConfig]];
		return leaves(value as Record<string, unknown>, name);
	});
}

// Sanity floors, not exact counts: they make the test fail loudly if Better Auth's
// endpoint shape changes and nothing is collected.
const MIN_EXPECTED_SDK_ENDPOINTS = 30;
const MIN_EXPECTED_BETTER_AUTH_ROUTES = 80;

const LABELS: Record<string, string> = {
	jwks: "jwks matches the jwt plugin configured as Neon Auth configures it",
};

describe("API_ENDPOINTS matches Better Auth routes", () => {
	const entries = leaves(
		API_ENDPOINTS as unknown as Record<string, unknown>,
	).map(
		([name, config]) =>
			[LABELS[name] ?? name, config] as [string, EndpointConfig],
	);

	test("collects a non-trivial set of routes", () => {
		expect(entries.length).toBeGreaterThan(MIN_EXPECTED_SDK_ENDPOINTS);
		expect(betterAuthRoutes.size).toBeGreaterThan(
			MIN_EXPECTED_BETTER_AUTH_ROUTES,
		);
	});

	test("jwks is served at the path Neon Auth configures", () => {
		expect(API_ENDPOINTS.jwks).toEqual({
			path: ".well-known/jwks.json",
			method: "GET",
		});
	});

	test.each(entries)("%s", (_name, { path, method }) => {
		const fullPath = `/${path}`;
		const methods =
			betterAuthRoutes.get(fullPath) ??
			(NEON_SPECIFIC_ROUTES[fullPath]
				? new Set(NEON_SPECIFIC_ROUTES[fullPath])
				: undefined);
		expect(methods, `no Better Auth route at ${fullPath}`).toBeDefined();
		expect(
			[...(methods ?? [])],
			`${fullPath} does not accept ${method}`,
		).toContain(method);
	});
});
