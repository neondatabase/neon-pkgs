// Kept out of api.ts so the ergonomic `@neon/sdk` client stays off the startup path of
// every command; callers load this module with `await import()`.

import { createNeonClient, NeonApiError as SdkApiError } from "@neon/sdk";
import {
	type ApiCallProps,
	cliFetch,
	DEFAULT_API_HOST,
	httpError,
	RETRY_COUNT,
	unreadableBodyError,
} from "./api.js";

/**
 * The `@neon/sdk` ergonomic client, for commands that run one of its multi-step workflows,
 * with the timeout, debug logging, user agent, and 423 retries of `getApiClient`. Throws;
 * pass failures through {@link fromSdkError}.
 */
export const getNeonClient = ({
	apiKey,
	apiHost,
	requestTimeoutMs,
}: ApiCallProps) =>
	createNeonClient({
		apiKey,
		baseUrl: apiHost ?? DEFAULT_API_HOST,
		fetch: cliFetch(requestTimeoutMs),
		retries: RETRY_COUNT,
		throwOnError: true,
	});

/**
 * Map an error from {@link getNeonClient} for the top-level handler. A management API
 * response becomes the CLI's `NeonApiError`, so 401 and SSO recovery apply. Anything else
 * keeps the SDK's message and drops its `cause`, so a socket code deep in the chain cannot
 * turn a "role was created, but…" message into the generic connectivity hint.
 */
export function fromSdkError(error: unknown, apiHost?: string): Error {
	const base = apiHost ?? DEFAULT_API_HOST;
	if (error instanceof SdkApiError && error.response?.url.startsWith(base)) {
		// The SDK quotes a 2xx body it could not parse, and that body can carry a password.
		return error.response.ok
			? unreadableBodyError(error.response, error.body)
			: httpError(error.response, error.body);
	}
	return new Error(error instanceof Error ? error.message : String(error));
}
