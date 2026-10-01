import {
	createNeonClient,
	NeonAbortError,
	NeonError,
	type Operation,
	NeonApiError as SdkApiError,
	NeonAuthError as SdkAuthError,
	NeonClientError as SdkClientError,
	NeonNetworkError as SdkNetworkError,
	NeonNotFoundError as SdkNotFoundError,
	NeonOperationError as SdkOperationError,
	NeonRateLimitError as SdkRateLimitError,
	NeonRequestTimeoutError as SdkRequestTimeoutError,
	NeonWaitTimeoutError as SdkWaitTimeoutError,
} from "@neon/sdk";
import { describe, expect, it } from "vitest";
import { make } from "./client.js";
import {
	NeonApiError,
	NeonAuthError,
	NeonClientError,
	NeonNetworkError,
	NeonNotFoundError,
	NeonOperationError,
	NeonRateLimitError,
	NeonRequestTimeoutError,
	NeonWaitTimeoutError,
	toNeonEffectError,
} from "./errors.js";

const http = { status: 0, code: "E", requestId: "req_1", body: { x: 1 } };
const operation: Operation = {
	id: "op_1",
	project_id: "p",
	action: "start_compute",
	status: "running",
	failures_count: 0,
	created_at: "2026-10-01T00:00:00Z",
	updated_at: "2026-10-01T00:00:00Z",
	total_duration_ms: 0,
};

describe("toNeonEffectError", () => {
	it.each([
		[
			new SdkApiError("server", { ...http, status: 500 }),
			NeonApiError,
			{ status: 500, code: "E", requestId: "req_1", body: { x: 1 } },
		],
		[
			new SdkNotFoundError("missing", { ...http, status: 404 }),
			NeonNotFoundError,
			{ status: 404, requestId: "req_1" },
		],
		[
			new SdkAuthError("denied", { ...http, status: 401 }),
			NeonAuthError,
			{ status: 401 },
		],
		[
			new SdkRateLimitError("slow down", { ...http, status: 429 }),
			NeonRateLimitError,
			{ status: 429 },
		],
		[
			new SdkOperationError("failed", {
				operationId: "op_1",
				status: "failed",
			}),
			NeonOperationError,
			{ operationId: "op_1", status: "failed" },
		],
		[
			new SdkRequestTimeoutError("late", { timeoutMs: 50 }),
			NeonRequestTimeoutError,
			{ timeoutMs: 50 },
		],
		[
			new SdkWaitTimeoutError("still running", {
				timeoutMs: 75,
				operations: [operation],
			}),
			NeonWaitTimeoutError,
			{ timeoutMs: 75, operations: [operation] },
		],
		[
			new SdkNetworkError("offline", { reason: "ECONNRESET" }),
			NeonNetworkError,
			{ reason: "ECONNRESET" },
		],
		[new SdkClientError("bad input"), NeonClientError, {}],
	])("maps %s", (sdkError, TaggedClass, fields) => {
		const mapped = toNeonEffectError(sdkError);

		expect(mapped).toBeInstanceOf(TaggedClass);
		expect(mapped.message).toBe(sdkError.message);
		expect(mapped.cause).toBe(sdkError);
		expect(mapped).toMatchObject(fields);
	});

	it("maps the base-class error createNeonClient throws for bad config", () => {
		const sdkError = new NeonError("no key", "client");

		const mapped = toNeonEffectError(sdkError);

		expect(mapped).toBeInstanceOf(NeonClientError);
		expect(mapped.cause).toBe(sdkError);
	});

	it("rethrows anything that is not an SDK error so Effect records a defect", () => {
		const bug = new TypeError("undefined is not a function");

		expect(() => toNeonEffectError(bug)).toThrow(bug);
	});

	it("rethrows an abort, which only an interrupted fiber produces", () => {
		const abort = new NeonAbortError("aborted");

		expect(() => toNeonEffectError(abort)).toThrow(abort);
	});
});

describe("make", () => {
	it("throws NeonClientError when the SDK rejects the configuration", () => {
		expect(() => make({ apiKey: "" })).toThrow(NeonClientError);
		expect(() => make({ apiKey: "k", retries: -1 })).toThrow(
			NeonClientError,
		);
	});

	it("exposes every SDK namespace and method", () => {
		const shape = (value: object): unknown =>
			Object.fromEntries(
				Object.entries(value).map(([key, child]) => [
					key,
					typeof child === "object" && child !== null
						? shape(child)
						: "fn",
				]),
			);
		const sdkShape = (value: object): unknown => {
			const entries: [string, unknown][] = [];
			for (const key of Object.getOwnPropertyNames(value)) {
				const child: unknown = Reflect.get(value, key);
				if (typeof child === "object" && child !== null) {
					entries.push([key, sdkShape(child)]);
				}
			}
			const proto = Object.getPrototypeOf(value);
			if (proto !== Object.prototype) {
				for (const key of Object.getOwnPropertyNames(proto)) {
					if (key !== "constructor") entries.push([key, "fn"]);
				}
			}
			return Object.fromEntries(entries);
		};
		const { client: _raw, ...sdk } = createNeonClient({ apiKey: "k" });

		expect(shape(make({ apiKey: "k" }))).toEqual(sdkShape(sdk));
	});
});
