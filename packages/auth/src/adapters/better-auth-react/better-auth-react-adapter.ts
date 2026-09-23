import { createAuthClient } from "better-auth/react";
import {
	NeonAuthAdapterCore,
	type NeonAuthAdapterCoreAuthOptions,
	type SupportedBetterAuthClientPlugins,
} from "../../core/adapter-core";

export type BetterAuthReactAdapterOptions = Omit<
	NeonAuthAdapterCoreAuthOptions,
	"baseURL"
>;

/**
 * Internal implementation class - use BetterAuthReactAdapter factory function instead
 */
class BetterAuthReactAdapterImpl extends NeonAuthAdapterCore {
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

/** Instance type for BetterAuthReactAdapter */
export type BetterAuthReactAdapterInstance = BetterAuthReactAdapterImpl;

/** Builder type that creates adapter instances */
type BetterAuthReactAdapterBuilder = (
	url: string,
	fetchOptions?: { headers?: Record<string, string> },
) => BetterAuthReactAdapterInstance;

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
 *     adapter: BetterAuthReactAdapter(),
 *   },
 *   dataApi: { url: 'https://data-api.example.com' },
 * });
 * ```
 */
export function BetterAuthReactAdapter(
	options?: BetterAuthReactAdapterOptions,
): BetterAuthReactAdapterBuilder {
	return (url: string, fetchOptions?: { headers?: Record<string, string> }) =>
		new BetterAuthReactAdapterImpl({
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
