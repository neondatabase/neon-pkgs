import {
	configuredBaseUrl,
	configuredOrgId,
	requireApiKey,
} from "@neon/e2e-harness";
import { createNeonClient, type NeonClient } from "../src/index.js";
import { isNeonError } from "../src/neon/errors.js";
import { formatNeonError } from "./format-error.js";

export {
	DEFAULT_REGION,
	detectApiKeyScope,
	e2eTest,
	uniqueProjectName,
} from "@neon/e2e-harness";

/**
 * A client configured exactly the way a consumer would configure it, including the
 * `orgId` default so created projects land in the throwaway org.
 */
export function makeClient(): NeonClient<false> {
	return createNeonClient({
		apiKey: requireApiKey(),
		orgId: configuredOrgId(),
		baseUrl: configuredBaseUrl(),
	});
}

/** The same client in `throwOnError` mode, for the narrowing tests. */
export function makeThrowingClient(): NeonClient<true> {
	return createNeonClient({
		apiKey: requireApiKey(),
		orgId: configuredOrgId(),
		baseUrl: configuredBaseUrl(),
		throwOnError: true,
	});
}

/**
 * Unwrap a `{ data, error }` envelope in a test, failing loudly with the SDK's own error
 * message rather than a bare `undefined` dereference further down.
 */
export function expectOk<T>(result: {
	data?: T;
	error?: { message: string } | undefined;
}): T {
	if (result.error) {
		const detail = isNeonError(result.error)
			? formatNeonError(result.error)
			: result.error.message;
		throw new Error(`expected success, got: ${detail}`, {
			cause: result.error,
		});
	}
	return result.data as T;
}
