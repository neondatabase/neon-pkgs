import { Config, Context, Effect, Layer, Option, Redacted } from "effect";
import {
	make,
	type NeonEffectClient,
	type NeonEffectConfig,
} from "./client.js";
import { NeonClientError } from "./errors.js";

/** The Neon client as an Effect service. Provide it with {@link layer} or {@link layerConfig}. */
export class Neon extends Context.Service<Neon, NeonEffectClient>()(
	"@neon/effect/Neon",
) {}

const build = (config: NeonEffectConfig) =>
	Effect.try({
		try: () => make(config),
		catch: (error) => {
			if (error instanceof NeonClientError) return error;
			throw error;
		},
	});

/** Provide {@link Neon} from explicit configuration. Reads no environment variables. */
export const layer = (
	config: NeonEffectConfig,
): Layer.Layer<Neon, NeonClientError> => Layer.effect(Neon, build(config));

/**
 * Provide {@link Neon} from Effect `Config`: `NEON_API_KEY` (required, redacted) and
 * `NEON_ORG_ID` (optional, used as the default organization).
 */
export const layerConfig: Layer.Layer<
	Neon,
	NeonClientError | Config.ConfigError
> = Layer.effect(
	Neon,
	Effect.gen(function* () {
		const apiKey = yield* Config.Redacted("NEON_API_KEY");
		const orgId = yield* Config.option(Config.String("NEON_ORG_ID"));
		return yield* build({
			apiKey: Redacted.value(apiKey),
			orgId: Option.getOrUndefined(orgId),
		});
	}),
);
