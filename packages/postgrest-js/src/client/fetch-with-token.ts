/**
 * Fetch wrapper that automatically injects authentication tokens
 * Generic utility for adding token-based authentication to requests
 */

import { injectClientInfo } from "../utils/client-info.js";

type Fetch = typeof fetch;
type GetAccessToken = () => Promise<string | null>;

/**
 * Error thrown when authentication is required but no token is available
 */
export class AuthRequiredError extends Error {
	constructor(
		message = "Authentication required. A valid token is needed to access the resource.",
	) {
		super(message);
		this.name = "AuthRequiredError";
	}
}

/**
 * Creates a fetch wrapper that injects authentication tokens into every request
 *
 * This is a generic utility that can work with any token provider function.
 * The token is resolved lazily on each request.
 *
 * @param getAccessToken - Async function that returns current access token
 * @param customFetch - Optional custom fetch implementation
 * @returns Wrapped fetch function with authentication headers
 */
export function fetchWithToken(
	getAccessToken: GetAccessToken,
	customFetch?: Fetch,
): Fetch {
	const baseFetch = customFetch ?? fetch;

	return async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		// Get current access token (lazy resolution - called on every request)
		const accessToken = await getAccessToken();

		// Throw if authentication is required but no token is available
		if (!accessToken) {
			throw new AuthRequiredError();
		}

		const headers = injectClientInfo(init?.headers);

		// Inject Authorization header if not present (respects user overrides)
		if (!headers.has("Authorization")) {
			headers.set("Authorization", `Bearer ${accessToken}`);
		}

		// Execute request with injected headers
		return baseFetch(input, { ...init, headers });
	};
}
