import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SupabaseAuthAdapter } from "./supabase-adapter";

const BASE_URL = "https://auth.example.com/api/auth";

const NOW = new Date().toISOString();
const IN_ONE_HOUR = new Date(Date.now() + 60 * 60 * 1000).toISOString();

const SESSION_PAYLOAD = {
	session: {
		id: "sess_1",
		token: "opaque-session-token",
		userId: "user_1",
		expiresAt: IN_ONE_HOUR,
		createdAt: NOW,
		updatedAt: NOW,
	},
	user: {
		id: "user_1",
		email: "user@example.com",
		name: "Test User",
		emailVerified: true,
		image: null,
		createdAt: NOW,
		updatedAt: NOW,
	},
};

const GOOGLE_ACCOUNT = {
	id: "acc_local_1",
	userId: "user_1",
	accountId: "google-sub-123",
	providerId: "google",
	scopes: ["openid", "email", "profile"],
	createdAt: NOW,
	updatedAt: NOW,
};

const CREDENTIAL_ACCOUNT = {
	id: "acc_local_2",
	userId: "user_1",
	accountId: "user@example.com",
	providerId: "credential",
	scopes: [],
	createdAt: NOW,
	updatedAt: NOW,
};

const GITHUB_ACCOUNT = {
	id: "acc_local_3",
	userId: "user_1",
	accountId: "github-456",
	providerId: "github",
	scopes: ["read:user", "user:email"],
	createdAt: NOW,
	updatedAt: NOW,
};

// better-auth 1.7.6 account-info rejects accounts with no stored provider
// access token, e.g. Google sign-in via signInWithIdToken without access_token.
const ACCESS_TOKEN_NOT_FOUND_RESPONSE = () =>
	Response.json(
		{ message: "Access token not found", code: "ACCESS_TOKEN_NOT_FOUND" },
		{ status: 400, statusText: "Bad Request" },
	);

const ACCOUNT_INFO_PAYLOAD = {
	account: {
		id: "acc_local_1",
		providerId: "google",
		accountId: "google-sub-123",
	},
	user: {
		email: "profile@gmail.com",
		name: "Profile Name",
		image: "https://example.com/avatar.png",
		emailVerified: true,
	},
	data: { sub: "google-sub-123" },
};

type RecordedRequest = { url: URL; method: string; body: unknown };

function requestUrl(input: string | URL | Request): URL {
	if (input instanceof Request) return new URL(input.url);
	return new URL(String(input));
}

describe("SupabaseAuthAdapter identities", () => {
	const originalFetch = globalThis.fetch;
	let requests: RecordedRequest[];
	let accountInfoResponse: (url: URL) => Response;
	let listAccountsResponse: () => Response;

	beforeEach(() => {
		requests = [];
		accountInfoResponse = () => Response.json(ACCOUNT_INFO_PAYLOAD);
		listAccountsResponse = () =>
			Response.json([GOOGLE_ACCOUNT, CREDENTIAL_ACCOUNT]);

		globalThis.fetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = requestUrl(input);
				const method = init?.method ?? "GET";
				const body =
					typeof init?.body === "string"
						? JSON.parse(init.body)
						: undefined;
				requests.push({ url, method, body });

				if (url.pathname.endsWith("/get-session")) {
					return Response.json(SESSION_PAYLOAD);
				}
				if (url.pathname.endsWith("/list-accounts")) {
					return listAccountsResponse();
				}
				if (url.pathname.endsWith("/account-info")) {
					return accountInfoResponse(url);
				}
				if (url.pathname.endsWith("/unlink-account")) {
					return Response.json({ status: true });
				}
				return Response.json(
					{ message: `unexpected ${url.pathname}` },
					{ status: 404 },
				);
			},
		) as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	const accountInfoRequests = () =>
		requests.filter((r) => r.url.pathname.endsWith("/account-info"));

	test("getUserIdentities queries account-info by the local account id only", async () => {
		const adapter = SupabaseAuthAdapter()(BASE_URL);

		const result = await adapter.getUserIdentities();

		expect(result.error).toBeNull();
		const infoRequests = accountInfoRequests();
		expect(infoRequests).toHaveLength(1);
		expect(Object.fromEntries(infoRequests[0].url.searchParams)).toEqual({
			accountId: "acc_local_1",
		});
	});

	test("getUserIdentities does not call account-info for credential accounts", async () => {
		const adapter = SupabaseAuthAdapter()(BASE_URL);

		const result = await adapter.getUserIdentities();

		expect(result.error).toBeNull();
		expect(
			accountInfoRequests().some(
				(r) => r.url.searchParams.get("accountId") === "acc_local_2",
			),
		).toBe(false);

		const credential = result.data?.identities.find(
			(i) => i.provider === "credential",
		);
		expect(credential?.identity_data).toEqual({
			provider: "credential",
			provider_id: "user@example.com",
			scopes: [],
		});
	});

	test("getUserIdentities maps profile fields from the top-level account-info user", async () => {
		const adapter = SupabaseAuthAdapter()(BASE_URL);

		const result = await adapter.getUserIdentities();

		const google = result.data?.identities.find(
			(i) => i.provider === "google",
		);
		expect(google?.identity_data).toMatchObject({
			provider: "google",
			provider_id: "google-sub-123",
			scopes: ["openid", "email", "profile"],
			email: "profile@gmail.com",
			name: "Profile Name",
			picture: "https://example.com/avatar.png",
			email_verified: true,
			sub: "google-sub-123",
		});
	});

	test("getUserIdentities falls back to basic identity data when account-info has no access token", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		accountInfoResponse = ACCESS_TOKEN_NOT_FOUND_RESPONSE;
		const adapter = SupabaseAuthAdapter()(BASE_URL);

		const result = await adapter.getUserIdentities();

		expect(result.error).toBeNull();
		const google = result.data?.identities.find(
			(i) => i.provider === "google",
		);
		expect(google).toMatchObject({
			id: "google-sub-123",
			identity_id: "acc_local_1",
			provider: "google",
			created_at: NOW,
			updated_at: NOW,
		});
		expect(google?.identity_data).toEqual({
			provider: "google",
			provider_id: "google-sub-123",
			scopes: ["openid", "email", "profile"],
		});
		expect(result.data?.identities).toHaveLength(2);
		expect(warn).toHaveBeenCalled();
	});

	test("getUserIdentities falls back per account, keeping enrichment for the others", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		listAccountsResponse = () =>
			Response.json([GOOGLE_ACCOUNT, GITHUB_ACCOUNT, CREDENTIAL_ACCOUNT]);
		accountInfoResponse = (url) =>
			url.searchParams.get("accountId") === "acc_local_1"
				? ACCESS_TOKEN_NOT_FOUND_RESPONSE()
				: Response.json({
						account: {
							id: "acc_local_3",
							providerId: "github",
							accountId: "github-456",
						},
						user: {
							email: "dev@github.example",
							name: "GitHub Dev",
							image: "https://example.com/gh.png",
							emailVerified: true,
						},
						data: { login: "ghdev" },
					});
		const adapter = SupabaseAuthAdapter()(BASE_URL);

		const result = await adapter.getUserIdentities();

		expect(result.error).toBeNull();
		const byProvider = Object.fromEntries(
			(result.data?.identities ?? []).map((i) => [i.provider, i]),
		);
		expect(Object.keys(byProvider).sort()).toEqual([
			"credential",
			"github",
			"google",
		]);
		expect(byProvider.google.identity_data).toEqual({
			provider: "google",
			provider_id: "google-sub-123",
			scopes: ["openid", "email", "profile"],
		});
		expect(byProvider.github.identity_data).toMatchObject({
			provider: "github",
			provider_id: "github-456",
			email: "dev@github.example",
			name: "GitHub Dev",
			login: "ghdev",
		});
	});

	test("getUserIdentities still surfaces list-accounts failures as an error result", async () => {
		listAccountsResponse = () =>
			Response.json(
				{ message: "Internal error" },
				{ status: 500, statusText: "Internal Server Error" },
			);
		const adapter = SupabaseAuthAdapter()(BASE_URL);

		const result = await adapter.getUserIdentities();

		expect(result.data).toBeNull();
		expect(result.error).not.toBeNull();
		expect(accountInfoRequests()).toHaveLength(0);
	});

	test("getUserIdentities maps ids with Supabase semantics", async () => {
		const adapter = SupabaseAuthAdapter()(BASE_URL);

		const result = await adapter.getUserIdentities();

		const google = result.data?.identities.find(
			(i) => i.provider === "google",
		);
		expect(google).toMatchObject({
			id: "google-sub-123",
			identity_id: "acc_local_1",
			user_id: "user_1",
		});
	});

	test("unlinkIdentity accepts an identity exactly as getUserIdentities returned it (#765)", async () => {
		const adapter = SupabaseAuthAdapter()(BASE_URL);
		const identities = await adapter.getUserIdentities();
		const google = identities.data?.identities.find(
			(i) => i.provider === "google",
		);
		if (!google) throw new Error("google identity missing from fixture");

		const result = await adapter.unlinkIdentity(google);

		expect(result.error).toBeNull();
		const unlinkRequests = requests.filter((r) =>
			r.url.pathname.endsWith("/unlink-account"),
		);
		expect(unlinkRequests).toHaveLength(1);
		expect(unlinkRequests[0].method).toBe("POST");
		expect(unlinkRequests[0].body).toEqual({ accountId: "acc_local_1" });
	});
});
