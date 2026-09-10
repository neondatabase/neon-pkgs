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

const scheduleTrigger = {
	type: "schedule",
	trigger_id: "trigger-abc",
	function_slug: "uptime",
	name: "uptime-check",
	function_path: "/",
	schedule: { cron: "*/15 * * * *" },
	enabled: true,
	version: 1,
	next_run_at: "2026-09-09T03:00:00Z",
	source_branch_id: "br-1",
	inherited: false,
};

describe("triggers map responses to the ergonomic shape", () => {
	it("list unwraps the triggers array", async () => {
		const neon = neonReturning(200, { triggers: [scheduleTrigger] });
		const { data, error } = await neon.triggers.list("p-1", "br-1");
		expect(error).toBeUndefined();
		expect(data).toHaveLength(1);
		expect(data?.[0]?.trigger_id).toBe("trigger-abc");
	});

	it("get unwraps the single trigger", async () => {
		const neon = neonReturning(200, { trigger: scheduleTrigger });
		const { data } = await neon.triggers.get("p-1", "br-1", "trigger-abc");
		expect(data?.name).toBe("uptime-check");
	});

	it("create unwraps the trigger from the envelope", async () => {
		const neon = neonReturning(201, { trigger: scheduleTrigger });
		const { data } = await neon.triggers.create("p-1", "br-1", {
			type: "schedule",
			function_slug: "uptime",
			name: "uptime-check",
			schedule: { cron: "*/15 * * * *" },
		});
		expect(data?.type).toBe("schedule");
	});

	it("update unwraps the trigger from the envelope", async () => {
		const neon = neonReturning(200, {
			trigger: { ...scheduleTrigger, enabled: false, next_run_at: null },
		});
		const { data } = await neon.triggers.update(
			"p-1",
			"br-1",
			"trigger-abc",
			{
				type: "schedule",
				enabled: false,
			},
		);
		expect(data?.enabled).toBe(false);
	});

	it("delete resolves without error on 204", async () => {
		const neon = neonReturning(204, undefined);
		const { error } = await neon.triggers.delete(
			"p-1",
			"br-1",
			"trigger-abc",
		);
		expect(error).toBeUndefined();
	});
});
