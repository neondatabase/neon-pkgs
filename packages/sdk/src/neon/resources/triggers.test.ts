import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";
import { NeonNotFoundError } from "../errors.js";

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

const trigger = {
	type: "schedule" as const,
	trigger_id: "trg-1",
	function_slug: "worker",
	name: "daily-refresh",
	function_path: "/",
	schedule: { cron: "0 9 * * *" },
	enabled: false,
	version: 1,
	next_run_at: null,
	source_branch_id: "br-1",
	inherited: false,
};

describe("functions.triggers", () => {
	it("lists the triggers array in one request", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: { triggers: [trigger] },
		}));

		const { data, error } = await neon.functions.triggers.list(
			"p-1",
			"br-1",
		);

		expect(error).toBeUndefined();
		expect(data).toEqual([trigger]);
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("GET");
		expect(calls[0].url).toContain("/projects/p-1/branches/br-1/triggers");
		expect(calls[0].url).not.toContain("cursor=");
	});

	it("lists an empty collection", async () => {
		const { neon } = neonRouting(() => ({
			status: 200,
			body: { triggers: [] },
		}));

		const { data, error } = await neon.functions.triggers.list(
			"p-1",
			"br-1",
		);
		expect(error).toBeUndefined();
		expect(data).toEqual([]);
	});

	it("creates with the request body and unwraps trigger", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 201,
			body: { trigger },
		}));

		const input = {
			type: "schedule" as const,
			function_slug: "worker",
			name: "daily-refresh",
			schedule: { cron: "0 9 * * *" },
			enabled: false,
		};
		const { data, error } = await neon.functions.triggers.create(
			"p-1",
			"br-1",
			input,
		);

		expect(error).toBeUndefined();
		expect(data).toEqual(trigger);
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("POST");
		expect(calls[0].body).toEqual(input);
	});

	it("gets by trigger id and passes inheritance fields through", async () => {
		const inherited = {
			...trigger,
			inherited: true,
			source_branch_id: "br-parent",
			next_run_at: null,
		};
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: { trigger: inherited },
		}));

		const { data, error } = await neon.functions.triggers.get(
			"p-1",
			"br-1",
			"trg-1",
		);

		expect(error).toBeUndefined();
		expect(data).toEqual(inherited);
		expect(calls[0].method).toBe("GET");
		expect(calls[0].url).toContain(
			"/projects/p-1/branches/br-1/triggers/trg-1",
		);
	});

	it("updates with the discriminator and unwraps trigger", async () => {
		const enabled = { ...trigger, enabled: true, version: 2 };
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: { trigger: enabled },
		}));

		const { data, error } = await neon.functions.triggers.update(
			"p-1",
			"br-1",
			"trg-1",
			{ type: "schedule", enabled: true },
		);

		expect(error).toBeUndefined();
		expect(data).toEqual(enabled);
		expect(calls[0].method).toBe("PATCH");
		expect(calls[0].body).toEqual({ type: "schedule", enabled: true });
	});

	it("deletes with a 204", async () => {
		const { neon, calls } = neonRouting(() => ({ status: 204 }));

		const { error } = await neon.functions.triggers.delete(
			"p-1",
			"br-1",
			"trg-1",
		);

		expect(error).toBeUndefined();
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("DELETE");
		expect(calls[0].url).toContain(
			"/projects/p-1/branches/br-1/triggers/trg-1",
		);
	});

	it("returns API errors on the error channel", async () => {
		const { neon } = neonRouting(() => ({
			status: 404,
			body: { message: "missing" },
		}));

		const { error } = await neon.functions.triggers.get(
			"p-1",
			"br-1",
			"missing",
		);
		expect(error).toBeInstanceOf(NeonNotFoundError);
	});
});
