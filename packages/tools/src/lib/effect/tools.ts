import { Effect, Predicate, Ref, Result, Schedule } from "effect";
import { NeonToolCallerError } from "../caller-error.js";
import type {
	NeonToolAnnotations,
	NeonToolExecutionContext,
} from "../operation.js";
import { type NeonToolError, toNeonToolError } from "./errors.js";

/** The tool shape an Effect tool is built from: any Neon tool, customized or not. */
export interface ExecutableNeonTool<Input = never, Output = unknown> {
	readonly id: string;
	readonly annotations: NeonToolAnnotations;
	execute(input: Input, context?: NeonToolExecutionContext): Promise<Output>;
}

/** The execution context of an Effect tool. Interrupting the fiber cancels the call. */
export type NeonEffectToolContext = Omit<NeonToolExecutionContext, "signal">;

type ToolInput<Tool> =
	Tool extends ExecutableNeonTool<infer Input, unknown> ? Input : never;

type ToolOutput<Tool> =
	Tool extends ExecutableNeonTool<never, infer Output> ? Output : never;

/** A Neon tool whose `execute` returns an Effect. Every other field is unchanged. */
export type NeonEffectTool<
	Tool extends ExecutableNeonTool,
	Input = ToolInput<Tool>,
	Output = ToolOutput<Tool>,
> = Omit<Tool, "execute"> & {
	readonly execute: (
		input: Input,
		context?: NeonEffectToolContext,
	) => Effect.Effect<Output, NeonToolError>;
};

export type NeonEffectTools<
	Tools extends Readonly<Record<string, ExecutableNeonTool>>,
> = { readonly [Id in keyof Tools]: NeonEffectTool<Tools[Id]> };

/**
 * Which failures to retry and how. A policy only ever sees failures of
 * read-only tools: the adapter never resends a mutation, and leaves 423, 429,
 * and 503 responses to the SDK, which retries them and honours `Retry-After`.
 * A `NeonNetworkError` can arrive after the SDK already resent a `GET` whose
 * connection dropped.
 */
export interface NeonToolRetryPolicy {
	readonly schedule: Schedule.Schedule<unknown, NeonToolError>;
	/** Retries after the first attempt. */
	readonly times: number;
	readonly shouldRetry: (failure: {
		readonly tool: ExecutableNeonTool;
		readonly error: NeonToolError;
	}) => boolean;
}

export interface EffectToolOptions {
	/** No retries unless set. A retry runs the whole tool again, hooks included. */
	readonly retry?: NeonToolRetryPolicy;
}

/**
 * Retries a read-only tool that got no response from the Neon API, twice, with
 * jittered exponential backoff from 200 ms. A read is safe to send again; a
 * mutation that may have reached the API is not, so it is never retried.
 */
export const retryReadOnlyNetworkFailures: NeonToolRetryPolicy = {
	schedule: Schedule.exponential("200 millis").pipe(Schedule.jittered),
	times: 2,
	shouldRetry: ({ error }) => Predicate.isTagged(error, "NeonNetworkError"),
};

const SDK_RETRIED_STATUSES = new Set([423, 429, 503]);

const sdkRetried = (error: NeonToolError): boolean =>
	"status" in error &&
	typeof error.status === "number" &&
	SDK_RETRIED_STATUSES.has(error.status);

const mayRetry = (
	tool: ExecutableNeonTool,
	error: NeonToolError,
	policy: NeonToolRetryPolicy,
): boolean =>
	tool.annotations.readOnlyHint &&
	!sdkRetried(error) &&
	policy.shouldRetry({ tool, error });

// SQLSTATE classes that are the database's failure, not the statement's:
// connection, transaction rollback (serialization, deadlock), insufficient
// resources, object not in prerequisite state, operator intervention, system,
// configuration, and internal errors.
const SERVER_SQLSTATE_CLASSES = new Set([
	"08",
	"40",
	"53",
	"55",
	"57",
	"58",
	"F0",
	"XX",
]);

// Mistakes in the call: invalid input, a statement Postgres rejected, a
// mistake a tool reports as `NeonToolCallerError`, and any 4xx from the Neon
// API. Any other `NeonClientError` covers both SDK-side validation and
// malformed responses, so it counts as the server's.
const isCallerError = (error: NeonToolError): boolean => {
	if (Predicate.isTagged(error, "NeonSqlError")) {
		return !SERVER_SQLSTATE_CLASSES.has(error.code.slice(0, 2));
	}

	return (
		Predicate.isTagged(error, "NeonToolInputError") ||
		(Predicate.isTagged(error, "NeonClientError") &&
			error.cause instanceof NeonToolCallerError) ||
		("status" in error &&
			typeof error.status === "number" &&
			error.status < 500)
	);
};

/**
 * Run a Neon tool as an Effect, in a span named `NeonTools.<id>`. The span
 * records `error.type` for every failure but fails only for the server's: a
 * caller's mistake keeps it ok. `neon.tool.attempts` counts the attempts, and
 * `neon.tool.retried_error.type` names the failure a retry recovered from.
 */
export const toEffectTool = <Input, Output, Tool extends ExecutableNeonTool>(
	tool: Tool & ExecutableNeonTool<Input, Output>,
	options: EffectToolOptions = {},
): NeonEffectTool<Tool, Input, Output> => {
	const { retry } = options;

	const attempt = (
		input: Input,
		context: NeonEffectToolContext | undefined,
		attempts: Ref.Ref<number>,
	) =>
		Ref.updateAndGet(attempts, (n) => n + 1).pipe(
			Effect.flatMap((n) =>
				Effect.annotateCurrentSpan("neon.tool.attempts", n),
			),
			Effect.andThen(
				Effect.tryPromise({
					try: (signal) =>
						tool.execute(input, { ...context, signal }),
					catch: toNeonToolError,
				}),
			),
		);

	const run = (
		input: Input,
		context: NeonEffectToolContext | undefined,
		attempts: Ref.Ref<number>,
	) =>
		retry === undefined
			? attempt(input, context, attempts)
			: attempt(input, context, attempts).pipe(
					Effect.tapError((error) =>
						mayRetry(tool, error, retry)
							? Effect.annotateCurrentSpan(
									"neon.tool.retried_error.type",
									error._tag,
								)
							: Effect.void,
					),
					Effect.retry({
						schedule: retry.schedule,
						times: retry.times,
						while: (error) => mayRetry(tool, error, retry),
					}),
				);

	const execute = (input: Input, context?: NeonEffectToolContext) =>
		Ref.make(0).pipe(
			Effect.flatMap((attempts) => run(input, context, attempts)),
			Effect.map(Result.succeed),
			Effect.tapError((error) =>
				Effect.annotateCurrentSpan("error.type", error._tag),
			),
			Effect.catchIf(isCallerError, (error) =>
				Effect.succeed(Result.fail(error)),
			),
			Effect.withSpan(`NeonTools.${tool.id}`, {
				attributes: { "neon.tool.id": tool.id },
			}),
			Effect.flatMap(Effect.fromResult),
		);

	const { execute: _promiseExecute, ...descriptor } = tool;

	return { ...descriptor, execute };
};

/** Run every tool of a `createNeonTools` result as an Effect. */
export const toEffectTools = <
	Tools extends Readonly<Record<string, ExecutableNeonTool>>,
>(
	tools: Tools,
	options: EffectToolOptions = {},
): NeonEffectTools<Tools> =>
	Object.fromEntries(
		Object.entries(tools).map(([id, tool]) => [
			id,
			toEffectTool(tool, options),
		]),
	) as NeonEffectTools<Tools>;
