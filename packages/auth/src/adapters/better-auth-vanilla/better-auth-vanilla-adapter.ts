import { createAuthClient } from "better-auth/client";

import {
	NeonAuthAdapterCore,
	type NeonAuthAdapterCoreAuthOptions,
	type SupportedBetterAuthClientPlugins,
} from "../../core/adapter-core";

export type BetterAuthVanillaAdapterOptions = Omit<
	NeonAuthAdapterCoreAuthOptions,
	"baseURL"
>;

/**
 * Internal implementation class - use BetterAuthVanillaAdapter factory function instead
 */
class BetterAuthVanillaAdapterImpl extends NeonAuthAdapterCore {
	private _betterAuth: ReturnType<
		typeof createAuthClient<{ plugins: SupportedBetterAuthClientPlugins }>
	>;

	constructor(betterAuthClientOptions: NeonAuthAdapterCoreAuthOptions) {
		super(betterAuthClientOptions);
		this._betterAuth = createAuthClient(this.betterAuthOptions);
	}

	getBetterAuthInstance() {
		return this._betterAuth;
	}
}

/** Instance type for BetterAuthVanillaAdapter */
export type BetterAuthVanillaAdapterInstance = BetterAuthVanillaAdapterImpl;

/** Builder type that creates adapter instances */
export type BetterAuthVanillaAdapterBuilder = (
	url: string,
	fetchOptions?: { headers?: Record<string, string> },
) => BetterAuthVanillaAdapterInstance;

/**
 * Factory function that returns an adapter builder.
 * The builder is called by createClient/createAuthClient with the URL.
 *
 * @param options - Optional adapter configuration (baseURL is injected separately)
 * @returns A builder function that creates the adapter instance
 *
 * @example
 * ```typescript
 * const client = createClient({
 *   auth: {
 *     url: 'https://auth.example.com',
 *     adapter: BetterAuthVanillaAdapter(),
 *   },
 *   dataApi: { url: 'https://data-api.example.com' },
 * });
 * ```
 */
export function BetterAuthVanillaAdapter(
	options?: BetterAuthVanillaAdapterOptions,
): BetterAuthVanillaAdapterBuilder {
	return (url: string, fetchOptions?: { headers?: Record<string, string> }) =>
		new BetterAuthVanillaAdapterImpl({
			baseURL: url,
			...options,
			fetchOptions: {
				...options?.fetchOptions,
				headers: {
					...options?.fetchOptions?.headers,
					...fetchOptions?.headers,
				},
			},
		});
}
