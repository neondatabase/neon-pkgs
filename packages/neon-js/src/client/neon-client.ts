import type { NeonAuth, NeonAuthAdapter, NeonAuthPublicApi } from "@neon/auth";
import {
	type DefaultSchemaName,
	NeonPostgrestClient,
	type NeonPostgrestClientConstructorOptions,
} from "@neon/postgrest-js";

// Constructor options for NeonClient with required auth
export type NeonClientConstructorOptions<
	SchemaName,
	TAuth extends NeonAuthAdapter = NeonAuthAdapter,
> = NeonPostgrestClientConstructorOptions<SchemaName> & {
	authClient: NeonAuth<TAuth>;
};

/**
 * Neon client with integrated authentication
 *
 * Extends NeonPostgrestClient with Neon Auth integration.
 * For auth-free clients, use @neon/postgrest-js instead.
 */
export class NeonClient<
	// biome-ignore lint/suspicious/noExplicitAny: `any` is the default so an unspecified Database generic stays compatible with the upstream PostgrestClient's untyped schema.
	Database = any,
	SchemaName extends string & keyof Database = DefaultSchemaName<Database>,
	TAuth extends NeonAuthAdapter = NeonAuthAdapter,
> extends NeonPostgrestClient<Database, SchemaName> {
	auth: NeonAuthPublicApi<TAuth>;

	constructor({
		dataApiUrl,
		options,
		authClient,
	}: NeonClientConstructorOptions<SchemaName, TAuth>) {
		super({ dataApiUrl, options });

		this.auth = authClient.adapter;
	}
}

export type { DefaultSchemaName } from "@neon/postgrest-js";
