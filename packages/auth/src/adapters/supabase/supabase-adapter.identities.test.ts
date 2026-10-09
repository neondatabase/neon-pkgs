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
	accountId: "google-sub-123",
	providerId: "google",
	scopes: ["openid", "email", "profile"],
	createdAt: NOW,
	updatedAt: NOW,
};

const CREDENTIAL_ACCOUNT = {
	id: "acc_local_2",
	accountId: "user@example.com",
	providerId: "credential",
	scopes: [],
	createdAt: NOW,
	updatedAt: NOW,
};

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
	let accountInfoResponse: () => Response;

	beforeEach(() => {
		requests = [];
		accountInfoResponse = () => Response.json(ACCOUNT_INFO_PAYLOAD);

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
					return Response.json([GOOGLE_ACCOUNT, CREDENTIAL_ACCOUNT]);
				}
				if (url.pathname.endsWith("/account-info")) {
					return accountInfoResponse();
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

	test("getUserIdentities surfaces account-info failures as an error result", async () => {
		accountInfoResponse = () =>
			Response.json(
				{ message: "Account not found", code: "ACCOUNT_NOT_FOUND" },
				{ status: 400, statusText: "Bad Request" },
			);
		const adapter = SupabaseAuthAdapter()(BASE_URL);

		const result = await adapter.getUserIdentities();

		expect(result.data).toBeNull();
		expect(result.error?.code).toBe("identity_not_found");
	});

	test("unlinkIdentity sends only the local account id", async () => {
		const adapter = SupabaseAuthAdapter()(BASE_URL);
		const identities = await adapter.getUserIdentities();
		const google = identities.data?.identities.find(
			(i) => i.provider === "google",
		);
		if (!google) throw new Error("google identity missing from fixture");

		// unlinkIdentity looks the identity up by `i.id === identity.identity_id`,
		// so the local row id is supplied as identity_id here.
		const result = await adapter.unlinkIdentity({
			...google,
			identity_id: "acc_local_1",
		});

		expect(result.error).toBeNull();
		const unlinkRequests = requests.filter((r) =>
			r.url.pathname.endsWith("/unlink-account"),
		);
		expect(unlinkRequests).toHaveLength(1);
		expect(unlinkRequests[0].method).toBe("POST");
		expect(unlinkRequests[0].body).toEqual({ accountId: "acc_local_1" });
	});

	test.todo(
		"unlinkIdentity accepts an identity exactly as getUserIdentities returned it (#765)",
	);
});
