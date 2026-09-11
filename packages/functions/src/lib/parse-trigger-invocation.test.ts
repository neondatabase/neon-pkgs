import { describe, expect, it } from "vitest";

import { parseTriggerInvocation } from "./parse-trigger-invocation.js";

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

const parsedSchedule = {
	version: 1,
	invocationId,
	trigger: {
		type: "schedule",
		id: "trigger-66360036-ee42-4174-8ed5-416fa31757eb",
		name: "every-minute",
	},
	data: { scheduledAt: "2026-09-11T08:34:00Z" },
} as const;

function scheduleHeaders(header?: string): Headers {
	const headers = new Headers({ "content-type": "application/json" });
	if (header !== undefined) {
		headers.set(invocationIdHeader, header);
	}
	return headers;
}

function scheduleRequest(init?: {
	header?: string;
	body?: string | object;
}): Request {
	return new Request("https://example.test/cron", {
		method: "POST",
		headers: scheduleHeaders(init?.header ?? invocationId),
		body:
			typeof init?.body === "string"
				? init.body
				: JSON.stringify(init?.body ?? scheduleBody),
	});
}

describe("parseTriggerInvocation({ headers, body })", () => {
	it("accepts a schedule delivery whose header matches invocation_id", () => {
		const result = parseTriggerInvocation({
			headers: scheduleHeaders(invocationId),
			body: scheduleBody,
		});

		expect(result).toEqual({
			ok: true,
			invocation: parsedSchedule,
		});
	});

	it("trims the header before comparing", () => {
		const result = parseTriggerInvocation({
			headers: scheduleHeaders(` ${invocationId} `),
			body: scheduleBody,
		});

		expect(result.ok).toBe(true);
	});

	it("fails missing_header when the header is absent or blank", () => {
		expect(
			parseTriggerInvocation({
				headers: scheduleHeaders(),
				body: scheduleBody,
			}),
		).toEqual({ ok: false, error: "missing_header" });
		expect(
			parseTriggerInvocation({
				headers: scheduleHeaders("  "),
				body: scheduleBody,
			}),
		).toEqual({ ok: false, error: "missing_header" });
	});

	it("fails invocation_id_mismatch when the header does not match the body", () => {
		expect(
			parseTriggerInvocation({
				headers: scheduleHeaders("other-id"),
				body: scheduleBody,
			}),
		).toEqual({ ok: false, error: "invocation_id_mismatch" });
	});

	it("fails invalid_body for a malformed payload even when the header is set", () => {
		expect(
			parseTriggerInvocation({
				headers: scheduleHeaders(invocationId),
				body: null,
			}),
		).toEqual({ ok: false, error: "invalid_body" });
		expect(
			parseTriggerInvocation({
				headers: scheduleHeaders(invocationId),
				body: { ...scheduleBody, version: 2 },
			}),
		).toEqual({ ok: false, error: "invalid_body" });
		expect(
			parseTriggerInvocation({
				headers: scheduleHeaders(invocationId),
				body: {
					...scheduleBody,
					trigger: {
						...scheduleBody.trigger,
						type: "object_storage",
					},
				},
			}),
		).toEqual({ ok: false, error: "invalid_body" });
	});
});

describe("parseTriggerInvocation(request)", () => {
	it("accepts a schedule delivery Request", async () => {
		const result = await parseTriggerInvocation(scheduleRequest());

		expect(result).toEqual({
			ok: true,
			invocation: parsedSchedule,
		});
	});

	it("leaves the original Request body readable", async () => {
		const request = scheduleRequest();
		const parsed = await parseTriggerInvocation(request);

		expect(parsed.ok).toBe(true);
		expect(await request.json()).toEqual(scheduleBody);
	});

	it("fails invalid_body when the Request body is not JSON", async () => {
		expect(
			await parseTriggerInvocation(scheduleRequest({ body: "not-json" })),
		).toEqual({
			ok: false,
			error: "invalid_body",
		});
	});

	it("fails missing_header when the Request has no trigger header", async () => {
		const request = new Request("https://example.test/cron", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(scheduleBody),
		});

		expect(await parseTriggerInvocation(request)).toEqual({
			ok: false,
			error: "missing_header",
		});
	});

	it("fails missing_header before reading JSON when the header is absent", async () => {
		const request = new Request("https://example.test/cron", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not-json",
		});

		expect(await parseTriggerInvocation(request)).toEqual({
			ok: false,
			error: "missing_header",
		});
	});
});
