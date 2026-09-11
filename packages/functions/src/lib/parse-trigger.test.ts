import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { parseTrigger } from "./parse-trigger.js";
import { TRIGGER_INVOCATION_ID_HEADER } from "./parse-trigger-invocation.js";

const invocationId = "ucBDafV0gB8qoEM4UcdIu84Qx5JCAXYwpRnPVAagPa0";

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

describe("parseTrigger", () => {
	it("returns the parsed schedule invocation", async () => {
		const response = await app.request("/cron", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[TRIGGER_INVOCATION_ID_HEADER]: invocationId,
			},
			body: JSON.stringify(scheduleBody),
		});

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

	it("returns 401 when the trigger header is missing", async () => {
		const response = await app.request("/cron", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(scheduleBody),
		});

		expect(response.status).toBe(401);
		expect(await response.text()).toBe(
			`Missing ${TRIGGER_INVOCATION_ID_HEADER} header`,
		);
	});

	it("returns 401 when the header does not match invocation_id", async () => {
		const response = await app.request("/cron", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[TRIGGER_INVOCATION_ID_HEADER]: "other-id",
			},
			body: JSON.stringify(scheduleBody),
		});

		expect(response.status).toBe(401);
		expect(await response.text()).toBe("Invocation id mismatch");
	});

	it("returns 400 when the JSON body is not a schedule delivery", async () => {
		const response = await app.request("/cron", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[TRIGGER_INVOCATION_ID_HEADER]: invocationId,
			},
			body: JSON.stringify({}),
		});

		expect(response.status).toBe(400);
		expect(await response.text()).toBe("Invalid trigger payload");
	});

	it("returns 400 when the body is not JSON", async () => {
		const response = await app.request("/cron", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[TRIGGER_INVOCATION_ID_HEADER]: invocationId,
			},
			body: "not-json",
		});

		expect(response.status).toBe(400);
		expect(await response.text()).toBe("Invalid JSON body");
	});
});
