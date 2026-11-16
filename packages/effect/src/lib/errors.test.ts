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
import { Effect, Exit } from "effect";
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

	describe("errors from another copy of @neon/sdk", () => {
		// Another SDK copy defines its own classes, so its errors fail `instanceof`
		// against this package's copy and are matched by name and kind instead.
		class ForeignNotFoundError extends Error {
			readonly kind = "not_found";
			readonly status = 404;
			readonly code = "NOT_FOUND";
			readonly requestId = "req_2";
			readonly response = undefined;
			readonly body = { message: "missing" };
			constructor() {
				super("missing");
				this.name = "NeonNotFoundError";
			}
		}

		class ForeignNetworkError extends Error {
			readonly kind = "network";
			readonly reason = "ECONNRESET";
			constructor() {
				super("offline");
				this.name = "NeonNetworkError";
			}
		}

		it.each([
			[new ForeignNotFoundError(), NeonNotFoundError, { status: 404 }],
			[
				new ForeignNetworkError(),
				NeonNetworkError,
				{ reason: "ECONNRESET" },
			],
		])("maps %s", (foreign, TaggedClass, fields) => {
			const mapped = toNeonEffectError(foreign);

			expect(mapped).toBeInstanceOf(TaggedClass);
			expect(mapped.cause).toBe(foreign);
			expect(mapped).toMatchObject(fields);
		});

		it("rethrows an error that only borrows a Neon name", () => {
			const lookalike = new Error("not from the SDK");
			lookalike.name = "NeonApiError";

			expect(() => toNeonEffectError(lookalike)).toThrow(lookalike);
		});

		it.each([
			[
				"a kind that does not match the name",
				"NeonApiError",
				{ kind: "network" },
			],
			[
				"a missing field the class promises",
				"NeonApiError",
				{ kind: "api" },
			],
			[
				"a kind this package does not know",
				"NeonApiError",
				{ kind: "quota", status: 500 },
			],
			[
				"an optional field of the wrong type",
				"NeonApiError",
				{ kind: "api", status: 500, code: 123 },
			],
			[
				"a response that is not a Response",
				"NeonApiError",
				{ kind: "api", status: 500, response: "invalid" },
			],
			[
				"an operation without an id",
				"NeonWaitTimeoutError",
				{
					kind: "timeout",
					source: "wait",
					timeoutMs: 1,
					operations: [null],
				},
			],
			[
				"an operation missing the fields waitFor reads",
				"NeonWaitTimeoutError",
				{
					kind: "timeout",
					source: "wait",
					timeoutMs: 1,
					operations: [{ id: "op_1" }],
				},
			],
		])("rethrows %s", (_case, name, fields) => {
			const foreign = Object.assign(new Error("not quite SDK"), fields);
			foreign.name = name;

			expect(() => toNeonEffectError(foreign)).toThrow(foreign);
		});

		it("dies with a malformed lookalike as the catch of Effect.tryPromise", async () => {
			const foreign = Object.assign(new Error("not quite SDK"), {
				kind: "api",
				status: 500,
				code: 123,
			});
			foreign.name = "NeonApiError";

			const exit = await Effect.runPromiseExit(
				Effect.tryPromise({
					try: () => Promise.reject(foreign),
					catch: toNeonEffectError,
				}),
			);

			expect(exit).toStrictEqual(Exit.die(foreign));
		});
	});

	it("as the catch of Effect.tryPromise, fails with the tagged error and dies on anything else", async () => {
		const sdkError = new SdkNotFoundError("missing", {
			...http,
			status: 404,
		});
		const bug = new TypeError("undefined is not a function");

		const failed = await Effect.runPromise(
			Effect.tryPromise({
				try: () => Promise.reject(sdkError),
				catch: toNeonEffectError,
			}).pipe(Effect.flip),
		);
		const died = await Effect.runPromiseExit(
			Effect.tryPromise({
				try: () => Promise.reject(bug),
				catch: toNeonEffectError,
			}),
		);

		expect(failed).toBeInstanceOf(NeonNotFoundError);
		expect(failed.cause).toBe(sdkError);
		expect(died).toStrictEqual(Exit.die(bug));
	});
});

describe("make", () => {
	it("throws NeonClientError when the SDK rejects the configuration", () => {
		expect(() => make({ apiKey: "" })).toThrow(NeonClientError);
		expect(() => make({ apiKey: "k", retries: -1 })).toThrow(
			NeonClientError,
		);
	});

	it("runs a nested namespace call as an Effect, with API errors on the error channel", async () => {
		const answers = [
			{
				status: 200,
				body: { status: "success", data: ["service_name"] },
			},
			{ status: 400, body: { status: "error", error: "bad selector" } },
		];
		const neon = make({
			apiKey: "k",
			retries: 0,
			fetch: async () => {
				const answer = answers.shift();
				if (answer === undefined) throw new Error("unexpected request");
				return new Response(JSON.stringify(answer.body), {
					status: answer.status,
					headers: { "content-type": "application/json" },
				});
			},
		});
		const params = { projectId: "p", branchId: "b" };

		await expect(
			Effect.runPromise(neon.logs.loki.labels(params)),
		).resolves.toEqual({ status: "success", data: ["service_name"] });
		const failure = await Effect.runPromise(
			Effect.flip(neon.logs.loki.labels(params)),
		);
		expect(failure).toBeInstanceOf(NeonApiError);
		expect(failure.message).toBe("bad selector");
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
