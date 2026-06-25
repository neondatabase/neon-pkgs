import type { ConnectionDetails } from "../client/types.gen.js";
import { NeonError } from "./errors.js";
import { err, type NeonResult, ok } from "./result.js";

/**
 * Pick a connection string from a create response's `connection_uris`.
 *
 * Neon returns the **direct** URI; the pooled URI is the same string with the host
 * swapped for the `-pooler` host (`connection_parameters.pooler_host`), so we derive it
 * without an extra request. Returns `undefined` when the response carries no connection
 * URI (e.g. a branch created from a parent with multiple roles/databases).
 */
export function pickConnectionString(
	uris: ConnectionDetails[] | undefined,
	pooled: boolean,
): string | undefined {
	const details = uris?.[0];
	if (!details) return undefined;
	if (!pooled) return details.connection_uri;
	const { host, pooler_host } = details.connection_parameters;
	if (!host || !pooler_host) return details.connection_uri;
	return details.connection_uri.replace(host, pooler_host);
}

/**
 * Attach a derived connection string to a create result, returning a `client`-kind
 * {@link NeonError} when the response carries no connection URI.
 */
export function withConnectionString<D, T>(
	result: NeonResult<D>,
	uris: (data: D) => ConnectionDetails[] | undefined,
	build: (data: D, connectionString: string) => T,
	pooled: boolean,
): NeonResult<T> {
	if (result.error) return err(result.error);
	const connectionString = pickConnectionString(uris(result.data), pooled);
	if (!connectionString) {
		return err(
			new NeonError(
				"The response did not include a connection URI (the branch or project may have multiple roles or databases). Use `raw.getConnectionUri` with an explicit role and database.",
				"client",
			),
		);
	}
	return ok(build(result.data, connectionString));
}
