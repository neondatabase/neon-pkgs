import { describe, expect, expectTypeOf, it } from "vitest";

import {
	isScheduleTriggerInvocation,
	isStorageObjectCreatedTriggerInvocation,
	parseTriggerDelivery,
	parseTriggerInvocation,
	type ScheduleTriggerInvocation,
	type StorageObjectCreatedTriggerInvocation,
	type TriggerDelivery,
	type TriggerInvocation,
} from "./parse-trigger-invocation.js";

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
	type: "schedule",
	trigger: {
		type: "schedule",
		id: "trigger-66360036-ee42-4174-8ed5-416fa31757eb",
		name: "every-minute",
	},
	data: { scheduledAt: "2026-09-11T08:34:00Z" },
} as const;

const storageInvocationId = "LBLRZLmY62NxOKUOSntTS2CNCzcvDXNcVxl1F63dv_s";
const storageBody = {
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
};
const parsedStorage = {
	version: 1,
	invocationId: storageInvocationId,
	type: "storage_object_created",
	trigger: {
		type: "storage_object_created",
		id: "trigger-057464da-cff9-4ca5-9447-0a312ef351a3",
		name: "on-upload",
	},
	data: { bucketName: "uploads", objectKey: "smoke.txt" },
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

	it("narrows data after a type check on invocation.type", () => {
		const result = parseTriggerDelivery({
			headers: scheduleHeaders(invocationId),
			body: scheduleBody,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(isScheduleTriggerInvocation(result.invocation)).toBe(true);
		if (!isScheduleTriggerInvocation(result.invocation)) return;
		expectTypeOf(
			result.invocation.data.scheduledAt,
		).toEqualTypeOf<string>();
		expect(result.invocation.data.scheduledAt).toBe("2026-09-11T08:34:00Z");
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

	it("accepts a storage_object_created delivery whose header matches invocation_id", () => {
		const result = parseTriggerDelivery({
			headers: scheduleHeaders(storageInvocationId),
			body: storageBody,
		});

		expect(result).toEqual({
			ok: true,
			invocation: parsedStorage,
		});
		if (!result.ok) return;
		expect(isStorageObjectCreatedTriggerInvocation(result.invocation)).toBe(
			true,
		);
		if (!isStorageObjectCreatedTriggerInvocation(result.invocation)) return;
		expectTypeOf(result.invocation.data.objectKey).toEqualTypeOf<string>();
	});

	it("keeps parseTriggerInvocation schedule-only for a storage_object_created body", () => {
		expect(
			parseTriggerInvocation({
				headers: scheduleHeaders(storageInvocationId),
				body: storageBody,
			}),
		).toEqual({ ok: false, error: "invalid_body" });
	});

	it("accepts a ScheduleTriggerInvocation value without top-level type", () => {
		const existing: TriggerInvocation = {
			version: 1,
			invocationId: "id",
			trigger: { type: "schedule", id: "id", name: "cron" },
			data: { scheduledAt: "2026-09-16T00:00:00Z" },
		};
		expectTypeOf(existing.data.scheduledAt).toEqualTypeOf<string>();
	});

	it("keeps TriggerInvocation as the schedule alias", () => {
		expectTypeOf<TriggerInvocation>().toEqualTypeOf<ScheduleTriggerInvocation>();
		expectTypeOf<TriggerInvocation["data"]>().toEqualTypeOf<{
			scheduledAt: string;
		}>();
		expectTypeOf<TriggerDelivery>().toEqualTypeOf<
			| (ScheduleTriggerInvocation & { type: "schedule" })
			| StorageObjectCreatedTriggerInvocation
		>();

		function handleSchedule(invocation: TriggerInvocation) {
			return invocation.data.scheduledAt;
		}

		const result = parseTriggerInvocation({
			headers: scheduleHeaders(invocationId),
			body: scheduleBody,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expectTypeOf(handleSchedule(result.invocation)).toEqualTypeOf<string>();
		expect(handleSchedule(result.invocation)).toBe("2026-09-11T08:34:00Z");
	});

	it("narrows TriggerDelivery schedule-first and exhaustively", () => {
		const result = parseTriggerDelivery({
			headers: scheduleHeaders(invocationId),
			body: scheduleBody,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const invocation = result.invocation;
		if (invocation.type === "schedule") {
			expectTypeOf(invocation.data.scheduledAt).toEqualTypeOf<string>();
			expect(invocation.data.scheduledAt).toBe("2026-09-11T08:34:00Z");
		} else {
			expectTypeOf(invocation.data.objectKey).toEqualTypeOf<string>();
		}

		switch (invocation.type) {
			case "schedule":
				expectTypeOf(
					invocation.data.scheduledAt,
				).toEqualTypeOf<string>();
				break;
			case "storage_object_created":
				expectTypeOf(invocation.data.objectKey).toEqualTypeOf<string>();
				break;
			default: {
				const _exhaustive: never = invocation;
				throw new Error(`unexpected ${_exhaustive}`);
			}
		}
	});

	it("fails invalid_body when storage_object_created data omits object_key", () => {
		expect(
			parseTriggerDelivery({
				headers: scheduleHeaders(storageInvocationId),
				body: {
					...storageBody,
					data: { bucket_name: "uploads" },
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

	it("accepts a storage_object_created delivery Request", async () => {
		const result = await parseTriggerDelivery(
			scheduleRequest({
				header: storageInvocationId,
				body: storageBody,
			}),
		);

		expect(result).toEqual({
			ok: true,
			invocation: parsedStorage,
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
