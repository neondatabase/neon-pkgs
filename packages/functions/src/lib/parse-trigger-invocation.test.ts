import { describe, expect, it } from "vitest";

import {
	parseTriggerInvocation,
	TRIGGER_INVOCATION_ID_HEADER,
} from "./parse-trigger-invocation.js";

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

describe("parseTriggerInvocation", () => {
	it("accepts a schedule delivery whose header matches invocation_id", () => {
		const result = parseTriggerInvocation({
			header: invocationId,
			body: scheduleBody,
		});

		expect(result).toEqual({
			ok: true,
			invocation: {
				version: 1,
				invocationId,
				trigger: {
					type: "schedule",
					id: "trigger-66360036-ee42-4174-8ed5-416fa31757eb",
					name: "every-minute",
				},
				data: { scheduledAt: "2026-09-11T08:34:00Z" },
			},
		});
	});

	it("trims the header before comparing", () => {
		const result = parseTriggerInvocation({
			header: ` ${invocationId} `,
			body: scheduleBody,
		});

		expect(result.ok).toBe(true);
	});

	it("fails missing_header when the header is absent or blank", () => {
		expect(
			parseTriggerInvocation({ header: undefined, body: scheduleBody }),
		).toEqual({ ok: false, error: "missing_header" });
		expect(
			parseTriggerInvocation({ header: "  ", body: scheduleBody }),
		).toEqual({ ok: false, error: "missing_header" });
	});

	it("fails invocation_id_mismatch when the header does not match the body", () => {
		expect(
			parseTriggerInvocation({
				header: "other-id",
				body: scheduleBody,
			}),
		).toEqual({ ok: false, error: "invocation_id_mismatch" });
	});

	it("fails invalid_body for a malformed payload even when the header is set", () => {
		expect(
			parseTriggerInvocation({ header: invocationId, body: null }),
		).toEqual({ ok: false, error: "invalid_body" });
		expect(
			parseTriggerInvocation({
				header: invocationId,
				body: { ...scheduleBody, version: 2 },
			}),
		).toEqual({ ok: false, error: "invalid_body" });
		expect(
			parseTriggerInvocation({
				header: invocationId,
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

	it("exports the delivery header name", () => {
		expect(TRIGGER_INVOCATION_ID_HEADER).toBe(
			"x-neon-trigger-invocation-id",
		);
	});
});
