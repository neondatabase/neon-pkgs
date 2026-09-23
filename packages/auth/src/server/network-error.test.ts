import { describe, expect, test } from "vitest";
import { classifyFetchFailure } from "./network-error";

describe("classifyFetchFailure", () => {
	test("ENOTFOUND in cause maps to NETWORK_DNS", () => {
		const inner = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
			code: "ENOTFOUND",
			errno: -3008,
		});
		const err = new TypeError("fetch failed");
		(err as Error & { cause?: unknown }).cause = inner;

		const r = classifyFetchFailure(err);
		expect(r).toEqual({
			kind: "transport",
			code: "NETWORK_DNS",
			detail: "ENOTFOUND",
			clientMessage: "Could not resolve authentication server hostname",
		});
	});

	test("ECONNREFUSED maps to NETWORK_REFUSED", () => {
		const err = Object.assign(new Error("connect ECONNREFUSED"), {
			code: "ECONNREFUSED",
		});

		const r = classifyFetchFailure(err);
		expect(r.kind).toBe("transport");
		if (r.kind === "transport") {
			expect(r.code).toBe("NETWORK_REFUSED");
		}
	});

	test("legacy TypeError fetch maps to NETWORK_ERROR", () => {
		const r = classifyFetchFailure(new TypeError("Failed to fetch"));
		expect(r).toEqual({
			kind: "transport",
			code: "NETWORK_ERROR",
			detail: "fetch TypeError",
			clientMessage: "Unable to connect to authentication server",
		});
	});

	test("non-network Error maps to internal with generic client message", () => {
		const r = classifyFetchFailure(new Error("Something else"));
		expect(r).toEqual({
			kind: "internal",
			detail: "Something else",
			clientMessage: "Internal Server Error",
		});
	});

	test("AbortError maps to NETWORK_ABORT", () => {
		const err = new Error("Aborted");
		err.name = "AbortError";
		const r = classifyFetchFailure(err);
		expect(r.kind).toBe("transport");
		if (r.kind === "transport") {
			expect(r.code).toBe("NETWORK_ABORT");
		}
	});

	test("DOMException AbortError maps to NETWORK_ABORT", () => {
		const err = new DOMException("Aborted", "AbortError");
		const r = classifyFetchFailure(err);
		expect(r.kind).toBe("transport");
		if (r.kind === "transport") {
			expect(r.code).toBe("NETWORK_ABORT");
		}
	});
});
