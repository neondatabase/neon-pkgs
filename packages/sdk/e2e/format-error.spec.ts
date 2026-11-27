import { describe, expect, it } from "vitest";
import { toNeonError } from "../src/neon/errors.js";
import { formatNeonError } from "./format-error.js";

describe("formatNeonError", () => {
	it("keeps HTTP status and request id next to an unclassified API message", () => {
		const error = toNeonError(
			{ message: "unknown error" },
			new Response(null, {
				status: 500,
				headers: { "x-request-id": "req-1" },
			}),
		);
		expect(formatNeonError(error)).toBe(
			"unknown error (api, status 500, request req-1)",
		);
	});

	it("includes the transport reason for a network failure", () => {
		const error = toNeonError(
			Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }),
			undefined,
		);
		expect(error.kind).toBe("network");
		if (error.kind !== "network") throw new Error("unreachable");
		expect(formatNeonError(error)).toBe(
			`Network error: no response received from the Neon API (ECONNRESET). (network, ECONNRESET)`,
		);
	});
});
