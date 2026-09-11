import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { parseTrigger } from "./parse-trigger.js";

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

const app = new Hono();
app.post("/cron", async (c) => c.json(await parseTrigger(c)));
app.post("/cron-reread", async (c) => {
	const invocation = await parseTrigger(c);
	const data = await c.req.json();
	return c.json({
		invocationId: invocation.invocationId,
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
	it("returns the parsed schedule invocation", async () => {
		const response = await app.request("/cron", cronRequest());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			version: 1,
			invocationId,
			trigger: {
				type: "schedule",
				id: "trigger-66360036-ee42-4174-8ed5-416fa31757eb",
				name: "every-minute",
			},
			data: { scheduledAt: "2026-09-11T08:34:00Z" },
		});
	});

	it("leaves the Hono request body readable", async () => {
		const response = await app.request("/cron-reread", cronRequest());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			invocationId,
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
