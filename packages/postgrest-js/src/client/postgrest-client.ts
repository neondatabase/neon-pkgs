import { PostgrestClient } from "@supabase/postgrest-js";

// Constructor options for NeonPostgrestClient
export type NeonPostgrestClientConstructorOptions<SchemaName> = {
	dataApiUrl: string;
	options?: {
		db?: {
			schema?: Exclude<SchemaName, "__InternalSupabase">;
		};
		global?: {
			fetch: typeof fetch;
			headers?: Record<string, string>;
		};
	};
};

export type DefaultSchemaName<Database> = "public" extends keyof Database
	? "public"
	: string & keyof Database;

/**
 * Neon PostgreSQL client for querying the Neon Data API
 *
 * This is a generic PostgreSQL client without authentication built-in.
 * For auth-integrated clients, use @neondatabase/neon-js instead.
 *
 * Extends the upstream PostgrestClient with Neon-specific configuration.
 */
export class NeonPostgrestClient<
	// biome-ignore lint/suspicious/noExplicitAny: matches the upstream PostgrestClient's own `Database = any` default so type inference stays compatible when this generic is left unspecified.
	Database = any,
	SchemaName extends string & keyof Database = DefaultSchemaName<Database>,
> extends PostgrestClient<
	Database,
	{ PostgrestVersion: "12" },
	Exclude<SchemaName, "__InternalSupabase">
> {
	constructor({
		dataApiUrl,
		options,
	}: NeonPostgrestClientConstructorOptions<SchemaName>) {
		super(dataApiUrl, {
			headers: options?.global?.headers,
			fetch: options?.global?.fetch,
			schema: options?.db?.schema,
		});
	}
}
