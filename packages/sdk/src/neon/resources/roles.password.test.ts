import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";
import type { NeonConfig } from "../config.js";

function neonRouting(
	respond: (request: { url: string; method: string; body: unknown }) => {
		status: number;
		body: unknown;
	},
	config?: Pick<NeonConfig, "waitForReadiness" | "wait">,
) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	const neon = createNeonClient({
		apiKey: "test",
		retries: 0,
		...config,
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
			return new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		},
	});
	return { neon, calls };
}

const runningOp = {
	id: "op-1",
	project_id: "p-1",
	action: "apply_config",
	status: "running",
	failures_count: 0,
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
};

describe("roles.revealPassword / resetPassword", () => {
	it("maps revealPassword to the password string", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: { password: "s3cret" },
		}));

		const { data, error } = await neon.postgres.roles.revealPassword(
			"p-1",
			"br-1",
			"app_owner",
		);

		expect(error).toBeUndefined();
		expect(data).toBe("s3cret");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.url).toContain(
			"/projects/p-1/branches/br-1/roles/app_owner/reveal_password",
		);
	});

	it("maps resetPassword to the new password string", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: {
				role: {
					name: "app_owner",
					branch_id: "br-1",
					password: "n3w",
					created_at: "2026-01-01T00:00:00Z",
					updated_at: "2026-01-01T00:00:00Z",
				},
				operations: [],
			},
		}));

		const { data, error } = await neon.postgres.roles.resetPassword(
			"p-1",
			"br-1",
			"app_owner",
		);

		expect(error).toBeUndefined();
		expect(data).toBe("n3w");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toContain(
			"/projects/p-1/branches/br-1/roles/app_owner/reset_password",
		);
	});

	it("returns a client error when reset omits the password", async () => {
		const { neon } = neonRouting(() => ({
			status: 200,
			body: {
				role: {
					name: "app_owner",
					branch_id: "br-1",
					created_at: "2026-01-01T00:00:00Z",
					updated_at: "2026-01-01T00:00:00Z",
				},
				operations: [],
			},
		}));

		const { data, error } = await neon.postgres.roles.resetPassword(
			"p-1",
			"br-1",
			"app_owner",
		);

		expect(data).toBeUndefined();
		expect(error?.kind).toBe("client");
		expect(error?.message).toBe(
			"Reset returned a role without a password.",
		);
	});

	it("returns a client error when reset returns an empty password", async () => {
		const { neon } = neonRouting(() => ({
			status: 200,
			body: {
				role: {
					name: "app_owner",
					branch_id: "br-1",
					password: "",
					created_at: "2026-01-01T00:00:00Z",
					updated_at: "2026-01-01T00:00:00Z",
				},
				operations: [],
			},
		}));

		const { data, error } = await neon.postgres.roles.resetPassword(
			"p-1",
			"br-1",
			"app_owner",
		);

		expect(data).toBeUndefined();
		expect(error?.kind).toBe("client");
		expect(error?.message).toBe(
			"Reset returned a role without a password.",
		);
	});

	it("waits for reset operations before returning the password", async () => {
		const { neon, calls } = neonRouting(
			({ url }) => {
				if (url.includes("/operations/op-1")) {
					return {
						status: 200,
						body: {
							operation: { ...runningOp, status: "finished" },
						},
					};
				}
				return {
					status: 200,
					body: {
						role: {
							name: "app_owner",
							branch_id: "br-1",
							password: "n3w",
							created_at: "2026-01-01T00:00:00Z",
							updated_at: "2026-01-01T00:00:00Z",
						},
						operations: [runningOp],
					},
				};
			},
			{ waitForReadiness: true, wait: { pollIntervalMs: 1 } },
		);

		const { data, error } = await neon.postgres.roles.resetPassword(
			"p-1",
			"br-1",
			"app_owner",
		);

		expect(error).toBeUndefined();
		expect(data).toBe("n3w");
		expect(
			calls.some((call) => call.url.includes("/operations/op-1")),
		).toBe(true);
	});
});
