import { Effect, Predicate, Schedule } from "effect";
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
 * Which failures to retry and how. The SDK already retries 423, 429, and 503
 * responses, honouring `Retry-After`; a policy here covers what it leaves alone.
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
	shouldRetry: ({ tool, error }) =>
		tool.annotations.readOnlyHint &&
		Predicate.isTagged(error, "NeonNetworkError"),
};

/** Run a Neon tool as an Effect, with a span named `NeonTools.<id>`. */
export const toEffectTool = <Input, Output, Tool extends ExecutableNeonTool>(
	tool: Tool & ExecutableNeonTool<Input, Output>,
	options: EffectToolOptions = {},
): NeonEffectTool<Tool, Input, Output> => {
	const { retry } = options;

	const attempt = (
		input: Input,
		context: NeonEffectToolContext | undefined,
	) =>
		Effect.tryPromise({
			try: (signal) => tool.execute(input, { ...context, signal }),
			catch: toNeonToolError,
		});

	const run = (input: Input, context: NeonEffectToolContext | undefined) =>
		retry === undefined
			? attempt(input, context)
			: attempt(input, context).pipe(
					Effect.retry({
						schedule: retry.schedule,
						times: retry.times,
						while: (error) => retry.shouldRetry({ tool, error }),
					}),
				);

	const execute = Effect.fn(`NeonTools.${tool.id}`)(function* (
		input: Input,
		context?: NeonEffectToolContext,
	) {
		return yield* run(input, context);
	});

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
