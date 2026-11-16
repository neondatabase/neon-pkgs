/**
 * `@neon/tools/effect` — run Neon tools as Effects: typed errors, interruption that
 * cancels the call, a span per tool, and opt-in retries.
 *
 * Requires the optional peer dependencies `effect` and `@neon/effect`.
 *
 * @example
 * ```ts
 * import { createNeonTools } from "@neon/tools";
 * import { toEffectTools } from "@neon/tools/effect";
 * import { Effect } from "effect";
 *
 * const tools = toEffectTools(createNeonTools({ tools: ["projects.list"] }));
 *
 * const program = tools["projects.list"]
 *   .execute({}, { apiKey: process.env.NEON_API_KEY })
 *   .pipe(Effect.catchTag("NeonAuthError", () => Effect.succeed(undefined)));
 * ```
 */

export {
	NeonSqlConnectionError,
	NeonSqlError,
	type NeonToolError,
	NeonToolInputError,
	toNeonToolError,
} from "./lib/effect/errors.js";
export {
	type EffectToolOptions,
	type ExecutableNeonTool,
	type NeonEffectTool,
	type NeonEffectToolContext,
	type NeonEffectTools,
	type NeonToolRetryPolicy,
	retryReadOnlyNetworkFailures,
	toEffectTool,
	toEffectTools,
} from "./lib/effect/tools.js";
