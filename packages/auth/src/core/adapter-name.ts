import type { NeonAuthAdapter } from "../neon-auth";

/** Closed set of values reported in the `adapter` field of X-Neon-Client-Info. */
export type NeonAuthAdapterName =
	| "supabase"
	| "better-auth-vanilla"
	| "better-auth-react";

type AdapterBuilder = (
	url: string,
	fetchOptions?: { headers?: Record<string, string> },
) => NeonAuthAdapter;

const builderNames = new WeakMap<AdapterBuilder, NeonAuthAdapterName>();

/**
 * Records which adapter a builder produces so callers that only hold the
 * builder (neon-js builds its header before the adapter is instantiated) can
 * report it. A WeakMap keeps the builder types unchanged.
 */
export function registerAdapterBuilder<B extends AdapterBuilder>(
	name: NeonAuthAdapterName,
	builder: B,
): B {
	builderNames.set(builder, name);
	return builder;
}

/**
 * Returns the adapter name for a builder; an absent builder means the default
 * (Better Auth vanilla). Hand-written builders are unknown, so they report nothing
 * rather than guessing.
 */
export function getAdapterName(
	builder?: AdapterBuilder,
): NeonAuthAdapterName | undefined {
	if (!builder) return "better-auth-vanilla";
	return builderNames.get(builder);
}
