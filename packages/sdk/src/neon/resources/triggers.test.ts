import { describe, expect, it } from "vitest";
import type {
	ScheduleTrigger,
	StorageObjectCreatedTrigger,
} from "../../client/types.gen.js";
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
	type: "schedule",
	trigger_id: "trg-1",
	function_slug: "worker",
	name: "daily-refresh",
	function_path: "/",
	schedule: { cron: "0 9 * * *" },
	enabled: false,
	version: 1,
	next_run_at: null,
	inherited: false,
} satisfies ScheduleTrigger;

const storageTrigger = {
	type: "storage_object_created",
	trigger_id: "trg-2",
	function_slug: "worker",
	name: "process-uploads",
	function_path: "/",
	storage_object_created: {
		bucket_name: "uploads",
		prefix: "incoming/",
	},
	enabled: true,
	version: 1,
	inherited: false,
} satisfies StorageObjectCreatedTrigger;

describe("triggers", () => {
	it("lists the triggers array in one request", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: { triggers: [trigger] },
		}));

		const { data, error } = await neon.triggers.list({
			projectId: "p-1",
			branchId: "br-1",
		});

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

		const { data, error } = await neon.triggers.list({
			projectId: "p-1",
			branchId: "br-1",
		});
		expect(error).toBeUndefined();
		expect(data).toEqual([]);
	});

	it("lists mixed schedule and storage triggers", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: { triggers: [trigger, storageTrigger] },
		}));

		const { data, error } = await neon.triggers.list({
			projectId: "p-1",
			branchId: "br-1",
		});

		expect(error).toBeUndefined();
		expect(data).toEqual([trigger, storageTrigger]);
		expect(data?.[1]).not.toHaveProperty("schedule");
		expect(data?.[1]).not.toHaveProperty("next_run_at");
		expect(calls).toHaveLength(1);
		expect(calls[0].url).not.toContain("cursor=");
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
		const { data, error } = await neon.triggers.create({
			projectId: "p-1",
			branchId: "br-1",
			...input,
		});

		expect(error).toBeUndefined();
		expect(data).toEqual(trigger);
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("POST");
		expect(calls[0].body).toEqual(input);
	});

	it("creates a storage_object_created trigger", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 201,
			body: { trigger: storageTrigger },
		}));

		const input = {
			type: "storage_object_created" as const,
			function_slug: "worker",
			name: "process-uploads",
			storage_object_created: {
				bucket_name: "uploads",
				prefix: "incoming/",
			},
		};
		const { data, error } = await neon.triggers.create({
			projectId: "p-1",
			branchId: "br-1",
			...input,
		});

		expect(error).toBeUndefined();
		expect(data).toEqual(storageTrigger);
		expect(data).not.toHaveProperty("schedule");
		expect(data).not.toHaveProperty("next_run_at");
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("POST");
		expect(calls[0].url).toContain("/projects/p-1/branches/br-1/triggers");
		expect(calls[0].body).toEqual(input);
	});

	it("gets by trigger id and passes inheritance fields through", async () => {
		const inherited = {
			...trigger,
			inherited: true,
			next_run_at: null,
		} satisfies ScheduleTrigger;
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: { trigger: inherited },
		}));

		const { data, error } = await neon.triggers.get({
			projectId: "p-1",
			branchId: "br-1",
			triggerId: "trg-1",
		});

		expect(error).toBeUndefined();
		expect(data).toEqual(inherited);
		expect(calls[0].method).toBe("GET");
		expect(calls[0].url).toContain(
			"/projects/p-1/branches/br-1/triggers/trg-1",
		);
	});

	it("updates with the discriminator and unwraps trigger", async () => {
		const enabled = {
			...trigger,
			enabled: true,
			version: 2,
		} satisfies ScheduleTrigger;
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: { trigger: enabled },
		}));

		const { data, error } = await neon.triggers.update({
			projectId: "p-1",
			branchId: "br-1",
			triggerId: "trg-1",
			type: "schedule",
			enabled: true,
		});

		expect(error).toBeUndefined();
		expect(data).toEqual(enabled);
		expect(calls[0].method).toBe("PATCH");
		expect(calls[0].body).toEqual({ type: "schedule", enabled: true });
	});

	it("updates a storage_object_created trigger without replacing config", async () => {
		const disabled = {
			...storageTrigger,
			enabled: false,
			version: 2,
		} satisfies StorageObjectCreatedTrigger;
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: { trigger: disabled },
		}));

		const { data, error } = await neon.triggers.update({
			projectId: "p-1",
			branchId: "br-1",
			triggerId: "trg-2",
			type: "storage_object_created",
			enabled: false,
		});

		expect(error).toBeUndefined();
		expect(data).toEqual(disabled);
		expect(calls[0].method).toBe("PATCH");
		expect(calls[0].url).toContain(
			"/projects/p-1/branches/br-1/triggers/trg-2",
		);
		expect(calls[0].body).toEqual({
			type: "storage_object_created",
			enabled: false,
		});
	});

	it("deletes with a 204", async () => {
		const { neon, calls } = neonRouting(() => ({ status: 204 }));

		const { error } = await neon.triggers.delete({
			projectId: "p-1",
			branchId: "br-1",
			triggerId: "trg-1",
		});

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

		const { error } = await neon.triggers.get({
			projectId: "p-1",
			branchId: "br-1",
			triggerId: "missing",
		});
		expect(error).toBeInstanceOf(NeonNotFoundError);
	});
});
