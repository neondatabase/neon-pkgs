import type { BetterAuthClientOptions } from "better-auth/client";

import {
	adminClient,
	emailOTPClient,
	jwtClient,
	magicLinkClient,
	organizationClient,
	phoneNumberClient,
} from "better-auth/client/plugins";
import { anonymousTokenClient } from "../plugins/anonymous-token";
import type { BetterAuthInstance } from "../types";
import { injectClientInfo } from "../utils/client-info";
import { normalizeBetterAuthError } from "./better-auth-helpers";
import {
	BETTER_AUTH_METHODS_HOOKS,
	BETTER_AUTH_METHODS_IN_FLIGHT_REQUESTS,
	deriveBetterAuthMethodFromUrl,
	initBroadcastChannel,
} from "./better-auth-methods";

export interface NeonAuthAdapterCoreAuthOptions
	extends Omit<BetterAuthClientOptions, "plugins"> {}

export const FORCE_FETCH_HEADER = "X-Force-Fetch";

const supportedBetterAuthClientPlugins = [
	jwtClient(),
	adminClient(),
	organizationClient(),
	emailOTPClient(),
	magicLinkClient(),
	phoneNumberClient(),
	anonymousTokenClient(),
] satisfies BetterAuthClientOptions["plugins"];

export type SupportedBetterAuthClientPlugins =
	typeof supportedBetterAuthClientPlugins;

export abstract class NeonAuthAdapterCore {
	protected betterAuthOptions: BetterAuthClientOptions & {
		plugins: SupportedBetterAuthClientPlugins;
		fetchOptions: {
			throw: false;
		};
	};

	/**
	 * Better Auth adapter implementing the NeonAuthClient interface.
	 * See CLAUDE.md for architecture details and API mappings.
	 */

	//#region Constructor
	constructor(betterAuthClientOptions: NeonAuthAdapterCoreAuthOptions) {
		// Preserve user's onSuccess callback if they provided one
		const userOnSuccess = betterAuthClientOptions.fetchOptions?.onSuccess;
		const userOnRequest = betterAuthClientOptions.fetchOptions?.onRequest;

		this.betterAuthOptions = {
			...betterAuthClientOptions,
			plugins: supportedBetterAuthClientPlugins,
			fetchOptions: {
				...betterAuthClientOptions.fetchOptions,
				throw: false,
				onRequest: (request) => {
					const url = request.url;
					const method = deriveBetterAuthMethodFromUrl(
						url.toString(),
					);
					if (method) {
						BETTER_AUTH_METHODS_HOOKS[method].onRequest(request);
					}
					userOnRequest?.(request);
				},
				customFetchImpl: async (url, init) => {
					const headers = injectClientInfo(init?.headers);
					// Skip deduplication if X-Force-Fetch header is present
					if (headers.has(FORCE_FETCH_HEADER)) {
						headers.delete(FORCE_FETCH_HEADER);
						const response = await fetch(url, { ...init, headers });

						// Check for HTTP errors. Route through normalizeBetterAuthError
						// so consumers always get a typed AuthApiError with `.status` + `.code`.
						if (!response.ok) {
							const body = await response
								.clone()
								.json()
								.catch(() => ({}));
							throw normalizeBetterAuthError({
								status: response.status,
								statusText: response.statusText,
								message:
									body.message ||
									`HTTP ${response.status} ${response.statusText}`,
								code: body.code,
								body,
							});
						}

						return response;
					}

					const betterAuthMethod = deriveBetterAuthMethodFromUrl(
						url.toString(),
					);
					if (betterAuthMethod) {
						const response = await BETTER_AUTH_METHODS_HOOKS[
							betterAuthMethod
						].beforeFetch?.(url, init);
						if (response) {
							return response;
						}
					}

					// Create body-aware deduplication key
					const method = init?.method || "GET";
					const body = init?.body || "";
					const key = `${method}:${url}:${body}`;

					const response =
						await BETTER_AUTH_METHODS_IN_FLIGHT_REQUESTS.deduplicate(
							key,
							() => fetch(url, { ...init, headers }),
						);

					// Check for HTTP errors before returning. Route through
					// normalizeBetterAuthError so consumers always get a typed
					// AuthApiError with `.status` + `.code`.
					if (!response.ok) {
						const errorBody = await response
							.clone()
							.json()
							.catch(() => ({}));
						throw normalizeBetterAuthError({
							status: response.status,
							statusText: response.statusText,
							message:
								errorBody.message ||
								`HTTP ${response.status} ${response.statusText}`,
							code: errorBody.code,
							body: errorBody,
						});
					}

					// Clone the response so each caller gets a fresh body stream
					// (Response bodies can only be read once, but deduplication shares the same Response)
					return response.clone();
				},
				onSuccess: async (ctx) => {
					// Capture JWT from any request that includes it
					const jwt = ctx.response.headers.get("set-auth-jwt");
					if (jwt) {
						// Inject JWT into response data BEFORE Better Auth processes it.
						// Better Auth will then update its internal state, triggering useSession.subscribe()
						// which will cache the session with JWT included (single cache-setting point).
						if (ctx.data?.session) {
							ctx.data.session.token = jwt;
						} else {
							console.warn(
								"[onSuccess] JWT found but no session data to inject into!",
							);
						}
					}

					const url = ctx.request.url.toString();
					const responseData = ctx.data;

					// Detect sign-in/sign-up
					const method = deriveBetterAuthMethodFromUrl(url);
					if (method) {
						BETTER_AUTH_METHODS_HOOKS[method].onSuccess(
							responseData,
						);
					}

					// Call user's onSuccess callback if they provided one
					await userOnSuccess?.(ctx);
				},
			},
		};

		initBroadcastChannel();
	}

	abstract getBetterAuthInstance(): BetterAuthInstance;

	/**
	 * Get JWT token for authenticated or anonymous access.
	 * Single source of truth for token retrieval logic.
	 *
	 * @param allowAnonymous - When true, fetches anonymous token if no session exists
	 * @returns JWT token string or null if unavailable
	 */
	async getJWTToken(allowAnonymous: boolean): Promise<string | null> {
		const client = this.getBetterAuthInstance();

		// First, try to get authenticated session JWT
		const session = await client.getSession();
		if (session.data?.session?.token) {
			return session.data.session.token;
		}

		// No authenticated session - check if anonymous access is allowed
		if (allowAnonymous) {
			const anonymousTokenResponse = await client.getAnonymousToken();
			return anonymousTokenResponse.data?.token ?? null;
		}

		// Anonymous access disabled - return null
		return null;
	}
}
