import {
	NeonApiError,
	NeonAuthError,
	NeonClientError,
	NeonNotFoundError,
	NeonRateLimitError,
} from "@neon/sdk";
import { describe, expect, test } from "vitest";
import { isAccessRefusal } from "./resources.js";

describe("isAccessRefusal", () => {
	test("skips only 403 and 404 API errors", () => {
		expect(
			isAccessRefusal(new NeonApiError("forbidden", { status: 403 })),
		).toBe(true);
		expect(
			isAccessRefusal(
				new NeonNotFoundError("not found", { status: 404 }),
			),
		).toBe(true);
	});

	test("keeps server errors, rate limits, auth failures, and non-API errors", () => {
		for (const status of [400, 409, 422, 500, 502, 503]) {
			expect(
				isAccessRefusal(
					new NeonApiError(`status ${status}`, { status }),
				),
				String(status),
			).toBe(false);
		}
		expect(
			isAccessRefusal(
				new NeonRateLimitError("slow down", { status: 429 }),
			),
		).toBe(false);
		expect(
			isAccessRefusal(new NeonAuthError("unauthorized", { status: 401 })),
		).toBe(false);
		expect(isAccessRefusal(new NeonClientError("bad input"))).toBe(false);
		expect(isAccessRefusal(new Error("network"))).toBe(false);
	});
});
