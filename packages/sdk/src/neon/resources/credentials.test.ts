import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";
import { NeonApiError, NeonNotFoundError } from "../errors.js";

function neonRouting(
	respond: (request: { url: string; method: string; body: unknown }) => {
		status: number;
		body?: unknown;
	},
	config?: { retries?: number },
) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	const neon = createNeonClient({
		apiKey: "test",
		retries: config?.retries ?? 0,
		fetch: async (input, init) => {
			const request = input instanceof Request ? input : undefined;
			const url = request ? request.url : String(input);
			const method = (
				request?.method ??
				init?.method ??
				"GET"
			).toUpperCase();
			const raw = request ? await request.clone().text() : init?.body;
			const call = {
				url,
				method,
				body:
					typeof raw === "string" && raw.length > 0
						? JSON.parse(raw)
						: raw,
			};
			calls.push(call);
			const { status, body } = respond(call);
			if (status === 204) {
				return new Response(null, { status });
			}
			return new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		},
	});
	return { neon, calls };
}

const meta = {
	token_id: "nak_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	token_id_short: "aaaaaaaaaaaa",
	scopes: ["storage:read", "telemetry:write"],
	principal_type: "user",
	created_at: "2026-09-10T00:00:00Z",
	branch_id: "br-1",
};

const created = {
	...meta,
	api_token: "nt_live_secret",
	s3_secret_access_key: "nsk_live_bbbb",
};

describe("credentials", () => {
	it("lists credential metadata", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: { credentials: [meta] },
		}));

		const { data, error } = await neon.credentials.list({
			projectId: "p-1",
			branchId: "br-1",
		});
		expect(error).toBeUndefined();
		expect(data).toEqual([meta]);
		expect(calls[0].method).toBe("GET");
		expect(calls[0].url).toContain(
			"/projects/p-1/branches/br-1/credentials",
		);
	});

	it("creates with the request body", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 201,
			body: created,
		}));

		const input = {
			name: "agent",
			scopes: ["storage:read" as const],
			principal_type: "user" as const,
		};
		const { data, error } = await neon.credentials.create({
			projectId: "p-1",
			branchId: "br-1",
			...input,
		});
		expect(error).toBeUndefined();
		expect(data).toEqual(created);
		expect(calls[0].method).toBe("POST");
		expect(calls[0].body).toEqual(input);
	});

	it("revokes with a 204", async () => {
		const { neon, calls } = neonRouting(() => ({ status: 204 }));
		const { error } = await neon.credentials.revoke({
			projectId: "p-1",
			branchId: "br-1",
			tokenId: meta.token_id,
		});
		expect(error).toBeUndefined();
		expect(calls[0].method).toBe("DELETE");
		expect(calls[0].url).toContain(
			`/projects/p-1/branches/br-1/credentials/${meta.token_id}`,
		);
	});

	it("reveals secrets with POST and no branch metadata", async () => {
		const secret = {
			token_id: meta.token_id,
			api_token: "nt_live_secret",
			s3_secret_access_key: "nsk_live_bbbb",
		};
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: secret,
		}));

		const { data, error } = await neon.credentials.reveal({
			projectId: "p-1",
			branchId: "br-1",
			tokenId: meta.token_id,
		});
		expect(error).toBeUndefined();
		expect(data).toEqual(secret);
		expect(data).not.toHaveProperty("branch_id");
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("POST");
		expect(calls[0].url).toContain(
			`/projects/p-1/branches/br-1/credentials/${meta.token_id}/reveal`,
		);
	});

	it("returns 404 from reveal as an error", async () => {
		const { neon } = neonRouting(() => ({
			status: 404,
			body: { message: "not found" },
		}));
		const { error } = await neon.credentials.reveal({
			projectId: "p-1",
			branchId: "br-1",
			tokenId: "missing",
		});
		expect(error).toBeInstanceOf(NeonNotFoundError);
	});

	it("returns 409 from reveal as an error without mutating", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 409,
			body: { message: "no recoverable secret" },
		}));
		const { error } = await neon.credentials.reveal({
			projectId: "p-1",
			branchId: "br-1",
			tokenId: meta.token_id,
		});
		expect(error).toBeInstanceOf(NeonApiError);
		expect(error).toMatchObject({ status: 409 });
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("POST");
	});

	it("rotates and returns replacement secrets with stable token id", async () => {
		const rotated = {
			...created,
			api_token: "nt_live_new",
			s3_secret_access_key: "nsk_live_new",
		};
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: rotated,
		}));

		const { data, error } = await neon.credentials.rotate({
			projectId: "p-1",
			branchId: "br-1",
			tokenId: meta.token_id,
		});
		expect(error).toBeUndefined();
		expect(data).toEqual(rotated);
		expect(data?.token_id).toBe(meta.token_id);
		expect(calls[0].method).toBe("POST");
		expect(calls[0].url).toContain(
			`/projects/p-1/branches/br-1/credentials/${meta.token_id}/rotate`,
		);
	});

	it("does not retry rotate on 500", async () => {
		const { neon, calls } = neonRouting(
			() => ({
				status: 500,
				body: { message: "boom" },
			}),
			{ retries: 2 },
		);

		const { error } = await neon.credentials.rotate({
			projectId: "p-1",
			branchId: "br-1",
			tokenId: meta.token_id,
		});
		expect(error).toBeInstanceOf(NeonApiError);
		expect(error).toMatchObject({ status: 500 });
		expect(calls).toHaveLength(1);
	});
});
