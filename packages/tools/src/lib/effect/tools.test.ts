import { NeonAuthError, NeonNetworkError } from "@neon/effect";
import { NeonDbError } from "@neondatabase/serverless";
import { Effect, Exit, Fiber, Option, Schedule, Tracer } from "effect";
import { describe, expect, test } from "vitest";
import * as z from "zod";
import { createNeonTools } from "../../index.js";
import {
	NeonSqlConnectionError,
	NeonSqlError,
	NeonToolInputError,
	toNeonToolError,
} from "./errors.js";
import {
	type NeonToolRetryPolicy,
	retryReadOnlyNetworkFailures,
	toEffectTool,
	toEffectTools,
} from "./tools.js";

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const toRequest = (input: RequestInfo | URL, init?: RequestInit) =>
	input instanceof Request ? input : new Request(input, init);

const projectsPage = { projects: [{ id: "project-1" }], pagination: {} };

/** A fetch that fails with no response `failures` times, then answers. */
const flakyFetch = (failures: number) => {
	const calls: Request[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push(toRequest(input, init));
		if (calls.length <= failures) {
			throw new TypeError("fetch failed");
		}
		return jsonResponse(projectsPage);
	};
	return { calls, fetch };
};

const immediateRetry: NeonToolRetryPolicy = {
	...retryReadOnlyNetworkFailures,
	schedule: Schedule.spaced("1 millis"),
};

describe("toEffectTools", () => {
	test("keeps every descriptor field and runs execute as an Effect", async () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.list"] as const,
			fetch: async () => jsonResponse(projectsPage),
		});
		const effectTools = toEffectTools(tools);
		const { execute: _execute, ...descriptor } = tools["projects.list"];

		const result = await Effect.runPromise(
			effectTools["projects.list"].execute({}),
		);

		expect(effectTools["projects.list"]).toMatchObject(descriptor);
		expect(result).toEqual({ data: [{ id: "project-1" }] });
	});

	test("fails with the tagged SDK error", async () => {
		const tools = toEffectTools(
			createNeonTools({
				apiKey: "bad-key",
				tools: ["projects.list"] as const,
				fetch: async () =>
					jsonResponse({ message: "Authentication failed" }, 401),
			}),
		);

		const error = await Effect.runPromise(
			Effect.flip(tools["projects.list"].execute({})),
		);

		expect(error).toBeInstanceOf(NeonAuthError);
	});

	test("fails with NeonToolInputError when the input fails its schema", async () => {
		const tools = toEffectTools(
			createNeonTools({
				apiKey: "test-key",
				tools: ["projects.get"] as const,
				fetch: async () => jsonResponse({}),
			}),
		);

		const error = await Effect.runPromise(
			// @ts-expect-error project_id is required
			Effect.flip(tools["projects.get"].execute({})),
		);

		expect(error).toBeInstanceOf(NeonToolInputError);
	});

	test("interrupting the fiber aborts the request", async () => {
		let resolveRequest: (request: Request) => void = () => undefined;
		const requested = new Promise<Request>((resolve) => {
			resolveRequest = resolve;
		});
		const tools = toEffectTools(
			createNeonTools({
				apiKey: "test-key",
				tools: ["projects.list"] as const,
				fetch: (input, init) => {
					const request = toRequest(input, init);
					resolveRequest(request);
					return new Promise<Response>((_, reject) => {
						request.signal.addEventListener("abort", () =>
							reject(request.signal.reason),
						);
					});
				},
			}),
		);

		const fiber = Effect.runFork(tools["projects.list"].execute({}));
		const request = await requested;
		await Effect.runPromise(Fiber.interrupt(fiber));
		const exit = await Effect.runPromise(Fiber.await(fiber));

		expect(request.signal.aborted).toBe(true);
		expect(Exit.hasInterrupts(exit)).toBe(true);
	});
});

describe("retries", () => {
	test("are off by default", async () => {
		const { calls, fetch } = flakyFetch(1);
		const tools = toEffectTools(
			createNeonTools({
				apiKey: "test-key",
				tools: ["projects.list"] as const,
				fetch,
			}),
		);

		const error = await Effect.runPromise(
			Effect.flip(tools["projects.list"].execute({})),
		);

		expect(error).toBeInstanceOf(NeonNetworkError);
		expect(calls).toHaveLength(1);
	});

	test("retry a read-only tool that got no response", async () => {
		const { calls, fetch } = flakyFetch(2);
		const tools = toEffectTools(
			createNeonTools({
				apiKey: "test-key",
				tools: ["projects.list"] as const,
				fetch,
			}),
			{ retry: retryReadOnlyNetworkFailures },
		);

		const result = await Effect.runPromise(
			tools["projects.list"].execute({}),
		);

		expect(result).toEqual({ data: [{ id: "project-1" }] });
		expect(calls).toHaveLength(3);
	});

	test("stop after the policy's retries and fail with the last error", async () => {
		const { calls, fetch } = flakyFetch(10);
		const tools = toEffectTools(
			createNeonTools({
				apiKey: "test-key",
				tools: ["projects.list"] as const,
				fetch,
			}),
			{ retry: immediateRetry },
		);

		const error = await Effect.runPromise(
			Effect.flip(tools["projects.list"].execute({})),
		);

		expect(error).toBeInstanceOf(NeonNetworkError);
		expect(calls).toHaveLength(3);
	});

	test("never resend a mutation", async () => {
		const { calls, fetch } = flakyFetch(1);
		const tools = toEffectTools(
			createNeonTools({
				apiKey: "test-key",
				tools: ["projects.delete"] as const,
				fetch,
			}),
			{ retry: immediateRetry },
		);

		const error = await Effect.runPromise(
			Effect.flip(
				tools["projects.delete"].execute({ project_id: "project-1" }),
			),
		);

		expect(tools["projects.delete"].annotations.readOnlyHint).toBe(false);
		expect(error).toBeInstanceOf(NeonNetworkError);
		expect(calls).toHaveLength(1);
	});

	test("never resend a mutation or an SDK-retried status, whatever the policy", async () => {
		const retryEverything: NeonToolRetryPolicy = {
			schedule: Schedule.spaced("1 millis"),
			times: 2,
			shouldRetry: () => true,
		};

		// Requests sent for one failing call, with and without the policy. The SDK's
		// own 423/429/503 retries count in both.
		const requestsSent = async (input: {
			readonly status: number;
			readonly tool: "projects.get" | "projects.delete";
			readonly retry?: NeonToolRetryPolicy;
		}) => {
			let sent = 0;
			const tools = toEffectTools(
				createNeonTools({
					apiKey: "test-key",
					tools: ["projects.get", "projects.delete"] as const,
					fetch: async () => {
						sent += 1;
						return jsonResponse(
							{ message: "failed" },
							input.status,
						);
					},
				}),
				{ retry: input.retry },
			);
			await Effect.runPromise(
				Effect.flip(
					tools[input.tool].execute({ project_id: "project-1" }),
				),
			);
			return sent;
		};

		for (const [tool, status] of [
			["projects.delete", 500],
			["projects.get", 423],
			["projects.get", 429],
			["projects.get", 503],
		] as const) {
			expect(
				await requestsSent({ tool, status, retry: retryEverything }),
			).toBe(await requestsSent({ tool, status }));
		}
	});

	test("stop when the fiber is interrupted during backoff", async () => {
		const { calls, fetch } = flakyFetch(10);
		const tools = toEffectTools(
			createNeonTools({
				apiKey: "test-key",
				tools: ["projects.list"] as const,
				fetch,
			}),
			{
				retry: {
					...retryReadOnlyNetworkFailures,
					schedule: Schedule.spaced("1 minute"),
				},
			},
		);

		const fiber = Effect.runFork(tools["projects.list"].execute({}));
		await Effect.runPromise(Effect.sleep("20 millis"));
		await Effect.runPromise(Fiber.interrupt(fiber));

		expect(calls).toHaveLength(1);
	});
});

type RecordedSpan = {
	readonly name: string;
	readonly parent: string | undefined;
	readonly attributes: Map<string, unknown>;
	exit: Exit.Exit<unknown, unknown> | undefined;
};

/** A tracer that keeps every span it starts, for asserting status and attributes. */
const recordingTracer = () => {
	const spans: RecordedSpan[] = [];
	const tracer = Tracer.make({
		span: (options) => {
			const recorded: RecordedSpan = {
				name: options.name,
				parent: Option.getOrUndefined(
					Option.map(options.parent, (parent) => parent.spanId),
				),
				attributes: new Map(),
				exit: undefined,
			};
			spans.push(recorded);
			const span: Tracer.Span = {
				_tag: "Span",
				name: options.name,
				spanId: `span-${spans.length}`,
				traceId: "trace",
				parent: options.parent,
				annotations: options.annotations,
				status: { _tag: "Started", startTime: options.startTime },
				attributes: recorded.attributes,
				links: options.links,
				sampled: options.sampled,
				kind: options.kind,
				end: (_endTime, exit) => {
					recorded.exit = exit;
				},
				attribute: (key, value) => {
					recorded.attributes.set(key, value);
				},
				event: () => undefined,
				addLinks: () => undefined,
			};
			return span;
		},
	});
	const toolSpan = (id: string) =>
		spans.find((span) => span.name === `NeonTools.${id}`);
	return { spans, tracer, toolSpan };
};

describe("tool spans", () => {
	test("keeps the span ok for a caller's mistake and records its type", async () => {
		const { tracer, toolSpan } = recordingTracer();
		const tools = toEffectTools(
			createNeonTools({
				apiKey: "test-key",
				tools: ["projects.get"] as const,
				fetch: async () => jsonResponse({ message: "not found" }, 404),
			}),
		);

		const invalid = await Effect.runPromiseExit(
			// @ts-expect-error project_id is required
			tools["projects.get"].execute({}).pipe(Effect.withTracer(tracer)),
		);
		const span = toolSpan(tools["projects.get"].id);

		expect(Exit.isFailure(invalid)).toBe(true);
		expect(span?.exit && Exit.isSuccess(span.exit)).toBe(true);
		expect(span?.attributes.get("error.type")).toBe("NeonToolInputError");
	});

	test("keeps the span ok for a 404 from the Neon API", async () => {
		const { tracer, toolSpan } = recordingTracer();
		const tools = toEffectTools(
			createNeonTools({
				apiKey: "test-key",
				tools: ["projects.get"] as const,
				fetch: async () => jsonResponse({ message: "not found" }, 404),
			}),
		);

		const error = await Effect.runPromise(
			Effect.flip(
				tools["projects.get"]
					.execute({ project_id: "missing" })
					.pipe(Effect.withTracer(tracer)),
			),
		);

		expect(error._tag).toBe("NeonNotFoundError");
		expect(toolSpan(tools["projects.get"].id)?.exit?._tag).toBe("Success");
		expect(
			toolSpan(tools["projects.get"].id)?.attributes.get("error.type"),
		).toBe("NeonNotFoundError");
	});

	test("fails the span for a server failure, nested under the caller's span", async () => {
		const { tracer, spans, toolSpan } = recordingTracer();
		const { fetch } = flakyFetch(5);
		const tools = toEffectTools(
			createNeonTools({
				apiKey: "test-key",
				tools: ["projects.list"] as const,
				fetch,
			}),
		);

		await Effect.runPromiseExit(
			tools["projects.list"]
				.execute({})
				.pipe(Effect.withSpan("request"), Effect.withTracer(tracer)),
		);
		const request = spans.find((span) => span.name === "request");
		const span = toolSpan(tools["projects.list"].id);

		expect(span?.exit?._tag).toBe("Failure");
		expect(span?.attributes.get("error.type")).toBe("NeonNetworkError");
		expect(span?.parent).toBe(
			`span-${String(spans.indexOf(request ?? spans[0]) + 1)}`,
		);
	});

	test("records the attempts and the failure a retry recovered from", async () => {
		const { tracer, toolSpan } = recordingTracer();
		const { fetch } = flakyFetch(1);
		const tools = toEffectTools(
			createNeonTools({
				apiKey: "test-key",
				tools: ["projects.list"] as const,
				fetch,
			}),
			{ retry: immediateRetry },
		);

		await Effect.runPromise(
			tools["projects.list"].execute({}).pipe(Effect.withTracer(tracer)),
		);
		const span = toolSpan(tools["projects.list"].id);

		expect(span?.exit?._tag).toBe("Success");
		expect(span?.attributes.get("neon.tool.attempts")).toBe(2);
		expect(span?.attributes.get("neon.tool.retried_error.type")).toBe(
			"NeonNetworkError",
		);
	});
});

describe("toEffectTool", () => {
	test("wraps a single tool", async () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.list"] as const,
			fetch: async () => jsonResponse(projectsPage),
		});

		const tool = toEffectTool(tools["projects.list"]);

		await expect(Effect.runPromise(tool.execute({}))).resolves.toEqual({
			data: [{ id: "project-1" }],
		});
	});
});

describe("toNeonToolError", () => {
	test("maps a statement Postgres rejected to NeonSqlError", () => {
		const cause = Object.assign(new NeonDbError("column does not exist"), {
			code: "42703",
			position: "8",
			hint: "Perhaps you meant another column.",
		});

		const mapped = toNeonToolError(cause);

		expect(mapped).toBeInstanceOf(NeonSqlError);
		expect(mapped).toMatchObject({
			code: "42703",
			position: "8",
			hint: "Perhaps you meant another column.",
			cause,
		});
	});

	test("maps a SQL failure without SQLSTATE to NeonSqlConnectionError", () => {
		const cause = new NeonDbError("Server error (HTTP status 500)");

		expect(toNeonToolError(cause)).toBeInstanceOf(NeonSqlConnectionError);
	});

	test("maps a schema failure to NeonToolInputError", () => {
		const parsed = z.object({ id: z.string() }).safeParse({});
		if (parsed.success) throw new Error("expected a schema failure");

		const mapped = toNeonToolError(parsed.error);

		expect(mapped).toBeInstanceOf(NeonToolInputError);
		expect(mapped).toMatchObject({ issues: parsed.error.issues });
	});

	test("rethrows anything else so Effect records a defect", () => {
		const bug = new TypeError("undefined is not a function");

		expect(() => toNeonToolError(bug)).toThrow(bug);
	});
});
