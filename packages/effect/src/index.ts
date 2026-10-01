/**
 * `@neon/effect` — Effect v4 bindings for the `@neon/sdk` ergonomic client.
 *
 * @example
 * ```ts
 * import { Neon, layerConfig } from "@neon/effect";
 * import { Effect, Stream } from "effect";
 *
 * const program = Effect.gen(function* () {
 *   const neon = yield* Neon;
 *   return yield* neon.projects.list().pipe(Stream.runCollect);
 * });
 *
 * Effect.runPromise(program.pipe(Effect.provide(layerConfig)));
 * ```
 */

export {
	make,
	type NeonEffectClient,
	type NeonEffectConfig,
} from "./lib/client.js";
export {
	NeonApiError,
	NeonAuthError,
	NeonClientError,
	type NeonEffectError,
	NeonNetworkError,
	NeonNotFoundError,
	NeonOperationError,
	NeonRateLimitError,
	NeonRequestTimeoutError,
	NeonWaitTimeoutError,
} from "./lib/errors.js";
export { layer, layerConfig, Neon } from "./lib/service.js";
