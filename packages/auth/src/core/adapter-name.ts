import type { NeonAuthAdapterName } from "@neon-internals/internal";
import type { NeonAuthAdapter } from "../neon-auth";
import type {
	NeonAuthAdapterCore,
	NeonAuthAdapterCoreAuthOptions,
} from "./adapter-core";

export type { NeonAuthAdapterName };

type AdapterBuilder = (
	url: string,
	fetchOptions?: { headers?: Record<string, string> },
) => NeonAuthAdapter;

interface NamedAdapterConstructor<TAdapter extends NeonAuthAdapterCore> {
	new (options: NeonAuthAdapterCoreAuthOptions): TAdapter;
	readonly adapterName: NeonAuthAdapterName;
}

const builderNames = new WeakMap<AdapterBuilder, NeonAuthAdapterName>();

/**
 * Builds the `(url, fetchOptions) => adapter` builder shared by every public
 * adapter factory and records the adapter's name against it, so callers that
 * only hold the builder (neon-js builds its header before the adapter is
 * instantiated) can report it. The name lives on the adapter class as static
 * metadata because an instance field is not set until `super()` returns.
 */
export function createAdapterBuilder<TAdapter extends NeonAuthAdapterCore>(
	Adapter: NamedAdapterConstructor<TAdapter>,
	options?: Omit<NeonAuthAdapterCoreAuthOptions, "baseURL">,
) {
	const builder = (
		url: string,
		fetchOptions?: { headers?: Record<string, string> },
	) =>
		new Adapter({
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

	builderNames.set(builder as unknown as AdapterBuilder, Adapter.adapterName);
	return builder;
}

/**
 * Returns the adapter name for a builder. Hand-written builders are unknown,
 * so they report nothing rather than guessing.
 */
export function getAdapterName(
	builder?: AdapterBuilder,
): NeonAuthAdapterName | undefined {
	return builder && builderNames.get(builder);
}
