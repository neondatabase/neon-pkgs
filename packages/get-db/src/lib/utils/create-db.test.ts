import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createClaimableDatabase } from "./create-db.js";
import { CLAIMABLE_POSTGRES_URLS } from "./urls.js";

describe("createClaimableDatabase", () => {
	const mockDbId = "test-db-id-123";
	const mockConnectionString = "postgresql://user:pass@host:5432/db";
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = global.fetch;
	});

	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	test("creates database with referrer parameter in POST request", async () => {
		const referrer = "npm:get-db|test-tool";
		const expectedPostUrl = CLAIMABLE_POSTGRES_URLS.CREATE_DATABASE_POST(
			mockDbId,
			referrer,
		);
		const expectedGetUrl =
			CLAIMABLE_POSTGRES_URLS.GET_DATABASE_DATA(mockDbId);

		const fetchCalls: Array<{ url: string; options?: RequestInit }> = [];
		global.fetch = vi.fn(
			async (url: string, options?: RequestInit): Promise<Response> => {
				fetchCalls.push({ url, options });

				if (fetchCalls.length === 1) {
					return {
						ok: true,
						json: async () => ({}),
					} as Response;
				}

				return {
					ok: true,
					json: async () => ({
						connection_string: mockConnectionString,
					}),
				} as Response;
			},
		) as typeof fetch;

		const result = await createClaimableDatabase({
			dbId: mockDbId,
			referrer,
		});

		expect(fetchCalls).toHaveLength(2);
		expect(fetchCalls[0].url).toBe(expectedPostUrl);
		expect(fetchCalls[0].url).toContain(
			`?referrer=${encodeURIComponent(referrer)}`,
		);
		expect(fetchCalls[0].options?.method).toBe("POST");
		expect(fetchCalls[0].options?.headers).toEqual({
			"Content-Type": "application/json",
		});

		expect(fetchCalls[1].url).toBe(expectedGetUrl);
		expect(fetchCalls[1].options?.method).toBe("GET");

		expect(result).toBe(mockConnectionString);
	});

	test("creates database without referrer parameter when referrer is empty string", async () => {
		const referrer = "";
		const expectedPostUrl = CLAIMABLE_POSTGRES_URLS.CREATE_DATABASE_POST(
			mockDbId,
			referrer,
		);

		const fetchCalls: Array<{ url: string; options?: RequestInit }> = [];
		global.fetch = vi.fn(
			async (url: string, options?: RequestInit): Promise<Response> => {
				fetchCalls.push({ url, options });

				if (fetchCalls.length === 1) {
					return { ok: true, json: async () => ({}) } as Response;
				}

				return {
					ok: true,
					json: async () => ({
						connection_string: mockConnectionString,
					}),
				} as Response;
			},
		) as typeof fetch;

		await createClaimableDatabase({ dbId: mockDbId, referrer });

		expect(fetchCalls[0].url).toBe(expectedPostUrl);
		expect(fetchCalls[0].url).not.toContain("?referrer=");
	});

	test("creates database without referrer parameter when referrer is undefined", async () => {
		const referrer = undefined as unknown as string;
		const expectedPostUrl = CLAIMABLE_POSTGRES_URLS.CREATE_DATABASE_POST(
			mockDbId,
			referrer,
		);

		const fetchCalls: Array<{ url: string; options?: RequestInit }> = [];
		global.fetch = vi.fn(
			async (url: string, options?: RequestInit): Promise<Response> => {
				fetchCalls.push({ url, options });

				if (fetchCalls.length === 1) {
					return { ok: true, json: async () => ({}) } as Response;
				}

				return {
					ok: true,
					json: async () => ({
						connection_string: mockConnectionString,
					}),
				} as Response;
			},
		) as typeof fetch;

		await createClaimableDatabase({ dbId: mockDbId, referrer });

		expect(fetchCalls[0].url).toBe(expectedPostUrl);
		expect(fetchCalls[0].url).not.toContain("?referrer=");
	});

	test("passes default CLI referrer from instantPostgres", async () => {
		// This tests the format that comes from instantPostgres
		const referrer = "npm:get-db|npm:get-db/cli";
		const expectedPostUrl = CLAIMABLE_POSTGRES_URLS.CREATE_DATABASE_POST(
			mockDbId,
			referrer,
		);

		const fetchCalls: Array<{ url: string; options?: RequestInit }> = [];
		global.fetch = vi.fn(
			async (url: string, options?: RequestInit): Promise<Response> => {
				fetchCalls.push({ url, options });

				if (fetchCalls.length === 1) {
					return { ok: true, json: async () => ({}) } as Response;
				}

				return {
					ok: true,
					json: async () => ({
						connection_string: mockConnectionString,
					}),
				} as Response;
			},
		) as typeof fetch;

		await createClaimableDatabase({ dbId: mockDbId, referrer });

		expect(fetchCalls[0].url).toBe(expectedPostUrl);
		expect(fetchCalls[0].url).toContain(
			`?referrer=${encodeURIComponent(referrer)}`,
		);
	});

	test("passes custom referrer with special characters", async () => {
		const referrer = "npm:get-db|vite-plugin@1.0.0";
		const expectedPostUrl = CLAIMABLE_POSTGRES_URLS.CREATE_DATABASE_POST(
			mockDbId,
			referrer,
		);

		const fetchCalls: Array<{ url: string; options?: RequestInit }> = [];
		global.fetch = vi.fn(
			async (url: string, options?: RequestInit): Promise<Response> => {
				fetchCalls.push({ url, options });

				if (fetchCalls.length === 1) {
					return { ok: true, json: async () => ({}) } as Response;
				}

				return {
					ok: true,
					json: async () => ({
						connection_string: mockConnectionString,
					}),
				} as Response;
			},
		) as typeof fetch;

		await createClaimableDatabase({ dbId: mockDbId, referrer });

		expect(fetchCalls[0].url).toBe(expectedPostUrl);
		expect(fetchCalls[0].url).toContain(
			`?referrer=${encodeURIComponent(referrer)}`,
		);
	});

	test("throws error when POST request fails", async () => {
		const referrer = "npm:get-db|test-tool";

		global.fetch = vi.fn(async (): Promise<Response> => {
			return {
				ok: false,
				status: 500,
				statusText: "Internal Server Error",
			} as Response;
		}) as typeof fetch;

		await expect(
			createClaimableDatabase({ dbId: mockDbId, referrer }),
		).rejects.toThrow("Failed to create database");
	});

	test("verifies POST request is made before GET request", async () => {
		const referrer = "npm:get-db|test-tool";
		const fetchCalls: string[] = [];

		global.fetch = vi.fn(async (url: string): Promise<Response> => {
			fetchCalls.push(url);

			if (fetchCalls.length === 1) {
				// First call should be POST
				expect(url).toContain("/api/v1/database/");
				expect(url).toContain("?referrer=");
				return { ok: true, json: async () => ({}) } as Response;
			}

			// Second call should be GET
			expect(url).toContain("/api/v1/database/");
			expect(url).not.toContain("?referrer=");
			return {
				ok: true,
				json: async () => ({
					connection_string: mockConnectionString,
				}),
			} as Response;
		}) as typeof fetch;

		await createClaimableDatabase({ dbId: mockDbId, referrer });

		expect(fetchCalls).toHaveLength(2);
	});

	test("includes correct headers for both POST and GET requests", async () => {
		const referrer = "npm:get-db|test-tool";
		const requestConfigs: RequestInit[] = [];

		global.fetch = vi.fn(
			async (_url: string, options?: RequestInit): Promise<Response> => {
				if (options) {
					requestConfigs.push(options);
				}

				if (requestConfigs.length === 1) {
					return { ok: true, json: async () => ({}) } as Response;
				}

				return {
					ok: true,
					json: async () => ({
						connection_string: mockConnectionString,
					}),
				} as Response;
			},
		) as typeof fetch;

		await createClaimableDatabase({ dbId: mockDbId, referrer });

		// Verify POST headers
		expect(requestConfigs[0].method).toBe("POST");
		expect(requestConfigs[0].headers).toEqual({
			"Content-Type": "application/json",
		});

		expect(requestConfigs[1].method).toBe("GET");
		expect(requestConfigs[1].headers).toEqual({
			"Content-Type": "application/json",
		});
	});

	test("returns connection string from GET request response", async () => {
		const referrer = "npm:get-db|test-tool";
		const expectedConnectionString =
			"postgresql://custom:pass@example.com:5432/customdb";

		let callCount = 0;
		global.fetch = vi.fn(async (): Promise<Response> => {
			callCount++;
			// POST request
			if (callCount === 1) {
				return { ok: true, json: async () => ({}) } as Response;
			}

			// GET request - return custom connection string
			return {
				ok: true,
				json: async () => ({
					connection_string: expectedConnectionString,
				}),
			} as Response;
		}) as typeof fetch;

		const result = await createClaimableDatabase({
			dbId: mockDbId,
			referrer,
		});

		expect(result).toBe(expectedConnectionString);
	});

	test("sends default settings with logical_replication false in POST body", async () => {
		const referrer = "npm:get-db|test-tool";
		const fetchCalls: Array<{ url: string; options?: RequestInit }> = [];

		global.fetch = vi.fn(
			async (url: string, options?: RequestInit): Promise<Response> => {
				fetchCalls.push({ url, options });

				if (fetchCalls.length === 1) {
					return { ok: true, json: async () => ({}) } as Response;
				}

				return {
					ok: true,
					json: async () => ({
						connection_string: mockConnectionString,
					}),
				} as Response;
			},
		) as typeof fetch;

		await createClaimableDatabase({ dbId: mockDbId, referrer });

		expect(fetchCalls[0].options?.body).toBeDefined();
		const body = JSON.parse(fetchCalls[0].options?.body as string);
		expect(body).toEqual({
			enable_logical_replication: false,
		});
	});

	test("sends logical_replication true when enabled in settings", async () => {
		const referrer = "npm:get-db|test-tool";
		const fetchCalls: Array<{ url: string; options?: RequestInit }> = [];

		global.fetch = vi.fn(
			async (url: string, options?: RequestInit): Promise<Response> => {
				fetchCalls.push({ url, options });

				if (fetchCalls.length === 1) {
					return { ok: true, json: async () => ({}) } as Response;
				}

				return {
					ok: true,
					json: async () => ({
						connection_string: mockConnectionString,
					}),
				} as Response;
			},
		) as typeof fetch;

		await createClaimableDatabase({
			dbId: mockDbId,
			referrer,
			settings: { logicalReplication: true },
		});

		expect(fetchCalls[0].options?.body).toBeDefined();
		const body = JSON.parse(fetchCalls[0].options?.body as string);
		expect(body).toEqual({
			enable_logical_replication: true,
		});
	});

	test("sends logical_replication false when explicitly disabled in settings", async () => {
		const referrer = "npm:get-db|test-tool";
		const fetchCalls: Array<{ url: string; options?: RequestInit }> = [];

		global.fetch = vi.fn(
			async (url: string, options?: RequestInit): Promise<Response> => {
				fetchCalls.push({ url, options });

				if (fetchCalls.length === 1) {
					return { ok: true, json: async () => ({}) } as Response;
				}

				return {
					ok: true,
					json: async () => ({
						connection_string: mockConnectionString,
					}),
				} as Response;
			},
		) as typeof fetch;

		await createClaimableDatabase({
			dbId: mockDbId,
			referrer,
			settings: { logicalReplication: false },
		});

		expect(fetchCalls[0].options?.body).toBeDefined();
		const body = JSON.parse(fetchCalls[0].options?.body as string);
		expect(body).toEqual({
			enable_logical_replication: false,
		});
	});

	test("sends empty settings object when settings parameter is empty", async () => {
		const referrer = "npm:get-db|test-tool";
		const fetchCalls: Array<{ url: string; options?: RequestInit }> = [];

		global.fetch = vi.fn(
			async (url: string, options?: RequestInit): Promise<Response> => {
				fetchCalls.push({ url, options });

				if (fetchCalls.length === 1) {
					return { ok: true, json: async () => ({}) } as Response;
				}

				return {
					ok: true,
					json: async () => ({
						connection_string: mockConnectionString,
					}),
				} as Response;
			},
		) as typeof fetch;

		await createClaimableDatabase({
			dbId: mockDbId,
			referrer,
			settings: {},
		});

		expect(fetchCalls[0].options?.body).toBeDefined();
		const body = JSON.parse(fetchCalls[0].options?.body as string);
		expect(body).toEqual({
			enable_logical_replication: false,
		});
	});
});
