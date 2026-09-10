import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";

/** Real ergonomic client whose only stub is the network boundary. */
function neonReturning(status: number, body: unknown) {
	return createNeonClient({
		apiKey: "test",
		retries: 0,
		fetch: async () =>
			new Response(body === undefined ? null : JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			}),
	});
}

describe("credentials reveal/rotate map responses to the ergonomic shape", () => {
	it("reveal unwraps the CredentialSecret body", async () => {
		const neon = neonReturning(200, {
			token_id: "nak_live_abc",
			api_token: "tok-secret",
			s3_secret_access_key: "nsk_live_xyz",
		});
		const { data, error } = await neon.credentials.reveal(
			"p-1",
			"br-1",
			"nak_live_abc",
		);
		expect(error).toBeUndefined();
		expect(data?.api_token).toBe("tok-secret");
		expect(data?.s3_secret_access_key).toBe("nsk_live_xyz");
	});

	it("rotate unwraps the RotateCredentialResponse body", async () => {
		const neon = neonReturning(200, {
			token_id: "nak_live_abc",
			token_id_short: "nak_live_abc",
			api_token: "tok-new",
			s3_secret_access_key: "nsk_live_new",
			scopes: [],
			branch_id: "br-1",
			principal_type: "user",
			created_at: "2026-09-09T00:00:00Z",
		});
		const { data, error } = await neon.credentials.rotate(
			"p-1",
			"br-1",
			"nak_live_abc",
		);
		expect(error).toBeUndefined();
		expect(data?.api_token).toBe("tok-new");
		expect(data?.token_id).toBe("nak_live_abc");
	});
});
