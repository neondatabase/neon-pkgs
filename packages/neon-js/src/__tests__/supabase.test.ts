import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../supabase";

describe("supabase createClient", () => {
	it("builds a client whose auth is the Supabase-compatible adapter", () => {
		const client = createClient({
			auth: { url: "https://auth.example.com" },
			dataApi: { url: "https://data-api.example.com/rest/v1" },
		});

		expect(typeof client.auth.signInWithPassword).toBe("function");
		expect(typeof client.from).toBe("function");
	});

	it("derives the Supabase client from a single base URL", () => {
		const client = createClient(
			"https://ep-xxx.c-2.us-east-2.aws.neon.build/dbname",
		);

		expect(typeof client.auth.signInWithPassword).toBe("function");
		expect((client as unknown as { url: string }).url).toBe(
			"https://ep-xxx.apirest.c-2.us-east-2.aws.neon.build/dbname/rest/v1",
		);
	});

	describe("adapter options", () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		function stubFetch() {
			const fetchMock = vi.fn(
				async (_input: RequestInfo | URL, _init?: RequestInit) =>
					new Response("null", {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			);
			vi.stubGlobal("fetch", fetchMock);
			return fetchMock;
		}

		function outgoingRequest(
			fetchMock: ReturnType<typeof stubFetch>,
		): Request {
			const [input, init] = fetchMock.mock.calls[0] ?? [];
			return new Request(input as RequestInfo | URL, init);
		}

		it("sends fetchOptions headers on auth requests (object form)", async () => {
			const fetchMock = stubFetch();
			const client = createClient({
				auth: {
					url: "https://auth.example.com",
					fetchOptions: { headers: { Cookie: "a=b" } },
				},
				dataApi: { url: "https://data-api.example.com/rest/v1" },
			});

			await client.auth.getSession();

			const request = outgoingRequest(fetchMock);
			expect(request.url).toContain("https://auth.example.com");
			expect(request.headers.get("cookie")).toBe("a=b");
			expect(request.headers.get("x-neon-client-info")).toBeTruthy();
		});

		it("sends fetchOptions headers on auth requests (string form)", async () => {
			const fetchMock = stubFetch();
			const client = createClient(
				"https://ep-xxx.c-2.us-east-2.aws.neon.build/dbname",
				{ auth: { fetchOptions: { headers: { Cookie: "a=b" } } } },
			);

			await client.auth.getSession();

			const request = outgoingRequest(fetchMock);
			expect(request.headers.get("cookie")).toBe("a=b");
		});
	});
});
