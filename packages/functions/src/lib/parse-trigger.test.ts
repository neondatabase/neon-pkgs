import { Hono } from "hono";
import { describe, expect, expectTypeOf, it } from "vitest";
import { parseTrigger } from "./parse-trigger.js";
import type { TriggerInvocation } from "./parse-trigger-invocation.js";

const invocationId = "ucBDafV0gB8qoEM4UcdIu84Qx5JCAXYwpRnPVAagPa0";
const invocationIdHeader = "x-neon-trigger-invocation-id";

const scheduleBody = {
	version: 1,
	invocation_id: invocationId,
	trigger: {
		type: "schedule",
		id: "trigger-66360036-ee42-4174-8ed5-416fa31757eb",
		name: "every-minute",
	},
	data: { scheduled_at: "2026-09-11T08:34:00Z" },
};

function handleSchedule(invocation: TriggerInvocation) {
	return invocation.data.scheduledAt;
}

const app = new Hono();
app.post("/cron", async (c) => c.json(await parseTrigger(c)));
app.post("/cron-typed", async (c) => {
	const invocation = await parseTrigger(c);
	expectTypeOf(handleSchedule(invocation)).toEqualTypeOf<string>();
	return c.json({ scheduledAt: handleSchedule(invocation) });
});
app.post("/cron-reread", async (c) => {
	const invocation = await parseTrigger(c);
	expectTypeOf(invocation.data.scheduledAt).toEqualTypeOf<string>();
	const data = await c.req.json();
	return c.json({
		invocationId: invocation.invocationId,
		scheduledAt: invocation.data.scheduledAt,
		bodyId: data.invocation_id,
	});
});

function cronRequest(init?: {
	omitHeader?: boolean;
	header?: string;
	body?: string | object;
}): RequestInit {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (!init?.omitHeader) {
		headers[invocationIdHeader] = init?.header ?? invocationId;
	}
	return {
		method: "POST",
		headers,
		body:
			typeof init?.body === "string"
				? init.body
				: JSON.stringify(init?.body ?? scheduleBody),
	};
}

describe("parseTrigger", () => {
	it("passes parseTrigger into a TriggerInvocation-typed schedule handler", async () => {
		const response = await app.request("/cron-typed", cronRequest());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			scheduledAt: "2026-09-11T08:34:00Z",
		});
	});

	it("returns the parsed schedule invocation", async () => {
		const response = await app.request("/cron", cronRequest());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			version: 1,
			invocationId,
			type: "schedule",
			trigger: {
				type: "schedule",
				id: "trigger-66360036-ee42-4174-8ed5-416fa31757eb",
				name: "every-minute",
			},
			data: { scheduledAt: "2026-09-11T08:34:00Z" },
		});
	});

	it("returns 400 for a storage_object_created delivery", async () => {
		const storageInvocationId =
			"LBLRZLmY62NxOKUOSntTS2CNCzcvDXNcVxl1F63dv_s";
		const response = await app.request(
			"/cron",
			cronRequest({
				header: storageInvocationId,
				body: {
					version: 1,
					invocation_id: storageInvocationId,
					trigger: {
						id: "trigger-057464da-cff9-4ca5-9447-0a312ef351a3",
						name: "on-upload",
						type: "storage_object_created",
					},
					data: {
						object_key: "smoke.txt",
						bucket_name: "uploads",
					},
				},
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.text()).toBe("Invalid trigger payload");
	});

	it("leaves the Hono request body readable", async () => {
		const response = await app.request("/cron-reread", cronRequest());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			invocationId,
			scheduledAt: "2026-09-11T08:34:00Z",
			bodyId: invocationId,
		});
	});

	it("returns 401 when the trigger header is missing", async () => {
		const response = await app.request(
			"/cron",
			cronRequest({ omitHeader: true }),
		);

		expect(response.status).toBe(401);
		expect(await response.text()).toBe(
			`Missing ${invocationIdHeader} header`,
		);
	});

	it("returns 401 when the header does not match invocation_id", async () => {
		const response = await app.request(
			"/cron",
			cronRequest({ header: "other-id" }),
		);

		expect(response.status).toBe(401);
		expect(await response.text()).toBe("Invocation id mismatch");
	});

	it("returns 400 when the JSON body is not a schedule delivery", async () => {
		const response = await app.request("/cron", cronRequest({ body: {} }));

		expect(response.status).toBe(400);
		expect(await response.text()).toBe("Invalid trigger payload");
	});

	it("returns 400 when the body is not JSON", async () => {
		const response = await app.request(
			"/cron",
			cronRequest({ body: "not-json" }),
		);

		expect(response.status).toBe(400);
		expect(await response.text()).toBe("Invalid trigger payload");
	});

	it("returns 401 when the trigger header is missing even if the body is not JSON", async () => {
		const response = await app.request(
			"/cron",
			cronRequest({ omitHeader: true, body: "not-json" }),
		);

		expect(response.status).toBe(401);
		expect(await response.text()).toBe(
			`Missing ${invocationIdHeader} header`,
		);
	});
});
