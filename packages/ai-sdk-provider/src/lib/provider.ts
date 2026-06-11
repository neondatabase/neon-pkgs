/**
 * Community Vercel AI SDK provider for the Neon AI Gateway.
 *
 * The surface mirrors other AI SDK providers — a `createNeon()` factory that returns a
 * provider object (see https://ai-sdk.dev/providers/community-providers). The real
 * implementation wraps the branch-scoped Neon AI Gateway (`NEON_AI_GATEWAY_BASE_URL` +
 * `NEON_AI_GATEWAY_TOKEN`) emitted by `neonctl env pull` / `neon dev`.
 *
 * NOT IMPLEMENTED YET: this `0.0.0` release only reserves the
 * `@neondatabase/ai-sdk-provider` package name. The integration ships in a follow-up release.
 */

/** Configuration for {@link createNeon}. */
export type NeonProviderSettings = {
	/** Neon AI Gateway base URL, e.g. the branch-scoped `NEON_AI_GATEWAY_BASE_URL`. */
	baseURL?: string;
	/** Neon AI Gateway token, e.g. `NEON_AI_GATEWAY_TOKEN`. */
	apiKey?: string;
};

/** The Neon AI SDK provider. The model surface is added in the first real release. */
export type NeonProvider = {
	readonly providerId: "neon";
};

/**
 * Creates a Neon AI SDK provider.
 *
 * NOT IMPLEMENTED YET: calling this throws. The `0.0.0` release is a name-reservation
 * placeholder; the Neon AI Gateway integration ships in a follow-up release.
 */
export function createNeon(_settings: NeonProviderSettings = {}): NeonProvider {
	throw new Error(
		"@neondatabase/ai-sdk-provider is not implemented yet (0.0.0 name-reservation release).",
	);
}
