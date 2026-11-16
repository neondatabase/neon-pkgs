import { NeonAuthError, NeonNetworkError } from "@neon/effect";
import { NeonDbError } from "@neondatabase/serverless";
import { Effect, Exit, Fiber, Schedule } from "effect";
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
