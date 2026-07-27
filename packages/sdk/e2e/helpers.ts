import { configuredOrgId, requireApiKey } from "@neon/e2e-harness";
import { createNeonClient, type NeonClient } from "../src/index.js";

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
	});
}

/** The same client in `throwOnError` mode, for the narrowing tests. */
export function makeThrowingClient(): NeonClient<true> {
	return createNeonClient({
		apiKey: requireApiKey(),
		orgId: configuredOrgId(),
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
		throw new Error(`expected success, got: ${result.error.message}`);
	}
	return result.data as T;
}
