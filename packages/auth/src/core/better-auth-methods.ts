import {
	getGlobalBroadcastChannel,
	type RequestContext,
} from "better-auth/client";
import { anonymousTokenResponseSchema } from "../plugins/anonymous-token";
import { isBrowser, isIframe } from "../utils/browser";
import { AnonymousTokenCacheManager } from "./anonymous-token-cache-manager";
import type { BetterAuthSession, BetterAuthUser } from "./better-auth-types";
import {
	NEON_AUTH_POPUP_CALLBACK_PARAM_NAME,
	NEON_AUTH_POPUP_CALLBACK_ROUTE,
	NEON_AUTH_POPUP_PARAM_NAME,
	NEON_AUTH_SESSION_VERIFIER_PARAM_NAME,
	OAUTH_POPUP_MESSAGE_TYPE,
} from "./constants";
import { InFlightRequestManager } from "./in-flight-request-manager";
import { openOAuthPopup } from "./oauth-popup";
import {
	type CachedSessionData,
	SessionCacheManager,
} from "./session-cache-manager";

interface SocialSignInResponse {
	redirect: boolean;
	url?: string;
	token?: string;
	user?: BetterAuthUser;
}

export const CURRENT_TAB_CLIENT_ID = crypto.randomUUID();

export const BETTER_AUTH_METHODS_IN_FLIGHT_REQUESTS =
	new InFlightRequestManager();

export const BETTER_AUTH_METHODS_CACHE = new SessionCacheManager();

export const BETTER_AUTH_ANONYMOUS_TOKEN_CACHE =
	new AnonymousTokenCacheManager();

/**
 * Auth change event types (adapter-agnostic).
 * Each adapter maps these to their specific event types if needed.
 */
export type NeonAuthChangeEvent =
	| "SIGNED_IN"
	| "SIGNED_OUT"
	| "TOKEN_REFRESHED"
	| "USER_UPDATED";

/** Internal canonical auth event types using Better Auth native format */
type InternalAuthEvent =
	| { type: "SIGN_IN"; data: CachedSessionData }
	| { type: "SIGN_OUT" }
	| { type: "TOKEN_REFRESH"; data: CachedSessionData }
	| { type: "USER_UPDATE"; data?: CachedSessionData };

type MethodHook = {
	beforeFetch?: (
		input: string | URL | globalThis.Request,
		init?: RequestInit,
	) => Promise<Response> | null | Response;
	// biome-ignore lint/suspicious/noConfusingVoidType: hook implementations are bare `() => {}` (void-returning) functions; `undefined` in the union isn't assignable from those the way `void` is.
	onRequest: (request: RequestContext) => void | RequestContext;
	onSuccess: (responseData: unknown) => void | Promise<void>;
};

export const BETTER_AUTH_ENDPOINTS = {
	signUp: "/sign-up",
	signIn: "/sign-in",
	signOut: "/sign-out",
	updateUser: "/update-user",
	getSession: "/get-session",
	token: "/token",
	anonymousSignIn: "/sign-in/anonymous",
	anonymousToken: "/token/anonymous",
} as const;

/**
 * Handles social sign-in via popup when running inside an iframe.
 * This is necessary because OAuth redirects don't work in iframes due to
 * X-Frame-Options/CSP restrictions from OAuth providers.
 *
 * Flow:
 * 1. Request OAuth URL from server (with disableRedirect)
 * 2. Open popup window with the OAuth URL
 * 3. Wait for popup to complete and send back the session verifier
 * 4. Navigate to callbackURL with verifier - normal page load handles session
 */
async function handleSocialSignInViaPopup(
	input: string | URL | globalThis.Request,
	init: RequestInit | undefined,
): Promise<Response> {
	const body = JSON.parse((init?.body as string) || "{}");
	const originalCallbackURL = body.callbackURL || "/";

	// Use /auth/callback (in middleware SKIP_ROUTES) so popup can send verifier via postMessage
	const popupCallbackUrl = new URL(
		NEON_AUTH_POPUP_CALLBACK_ROUTE,
		globalThis.location.origin,
	);
	popupCallbackUrl.searchParams.set(NEON_AUTH_POPUP_PARAM_NAME, "1");
	popupCallbackUrl.searchParams.set(
		NEON_AUTH_POPUP_CALLBACK_PARAM_NAME,
		originalCallbackURL,
	);
	body.callbackURL = popupCallbackUrl.toString();
	body.disableRedirect = true;

	const response = await fetch(input, {
		...init,
		body: JSON.stringify(body),
	});
	const data: SocialSignInResponse = await response.json();
	const oauthUrl = data.url;

	if (!oauthUrl) {
		throw new Error("Failed to get OAuth URL");
	}

	const popupResult = await openOAuthPopup(oauthUrl);
	if (!popupResult.verifier) {
		throw new Error("OAuth completed but no session verifier received");
	}

	const navigationUrl = new URL(
		originalCallbackURL,
		globalThis.location.origin,
	);
	navigationUrl.searchParams.set(
		NEON_AUTH_SESSION_VERIFIER_PARAM_NAME,
		popupResult.verifier,
	);

	globalThis.location.href = navigationUrl.toString();
	return Response.json(data, { status: response.status });
}

export const BETTER_AUTH_METHODS_HOOKS: Record<string, MethodHook> = {
	signUp: {
		onRequest: () => {},
		onSuccess: (responseData) => {
			if (isSessionResponseData(responseData)) {
				const sessionData = {
					session: responseData.session,
					user: responseData.user,
				};
				BETTER_AUTH_METHODS_CACHE.setCachedSession(sessionData);
				emitAuthEvent({ type: "SIGN_IN", data: sessionData });
			}
		},
	},
	signIn: {
		beforeFetch: (input, init) => {
			const url = typeof input === "string" ? input : input.toString();

			// Only intercept social sign-in when in iframe
			if (!url.includes("/sign-in/social") || !isIframe()) {
				return null; // Proceed with normal redirect flow
			}

			// In iframe - use popup flow instead
			return handleSocialSignInViaPopup(input, init);
		},
		onRequest: () => {},
		onSuccess: (responseData) => {
			if (isSessionResponseData(responseData)) {
				const sessionData = {
					session: responseData.session,
					user: responseData.user,
				};
				BETTER_AUTH_METHODS_CACHE.setCachedSession(sessionData);
				emitAuthEvent({ type: "SIGN_IN", data: sessionData });
			}
		},
	},
	signOut: {
		onRequest: () => {
			BETTER_AUTH_METHODS_CACHE.invalidateSessionCache();
			BETTER_AUTH_METHODS_IN_FLIGHT_REQUESTS.clearAll();
		},
		onSuccess: () => {
			BETTER_AUTH_METHODS_CACHE.clearSessionCache();
			emitAuthEvent({ type: "SIGN_OUT" });
		},
	},
	updateUser: {
		onRequest: () => {},
		onSuccess: (responseData) => {
			if (isSessionResponseData(responseData)) {
				const sessionData = {
					session: responseData.session,
					user: responseData.user,
				};
				BETTER_AUTH_METHODS_CACHE.setCachedSession(sessionData);
				emitAuthEvent({ type: "USER_UPDATE", data: sessionData });
			} else {
				BETTER_AUTH_METHODS_CACHE.clearSessionCache();
				emitAuthEvent({ type: "USER_UPDATE" });
			}
		},
	},
	getSession: {
		beforeFetch: () => {
			// When a session verifier is present (OAuth callback or magic link redirect),
			// skip the cache so the request reaches the server to finalize the session.
			if (isBrowser()) {
				const params = new URLSearchParams(
					globalThis.window.location.search,
				);
				if (params.has(NEON_AUTH_SESSION_VERIFIER_PARAM_NAME)) {
					return null;
				}
			}

			const cachedData = BETTER_AUTH_METHODS_CACHE.getCachedSession();
			if (!cachedData) {
				return null;
			}

			return Response.json(cachedData, {
				status: 200,
			});
		},
		onRequest: (ctx) => {
			if (!isBrowser()) {
				return;
			}

			const urlSearchParams = new URLSearchParams(
				globalThis.window.location.search,
			);
			const neonAuthSessionVerifierParam = urlSearchParams.get(
				NEON_AUTH_SESSION_VERIFIER_PARAM_NAME,
			);

			if (neonAuthSessionVerifierParam) {
				const url =
					typeof ctx.url === "string" ? new URL(ctx.url) : ctx.url;
				url.searchParams.set(
					NEON_AUTH_SESSION_VERIFIER_PARAM_NAME,
					neonAuthSessionVerifierParam,
				);

				return {
					...ctx,
					url,
				};
			}
		},
		onSuccess: (responseData) => {
			if (isSessionResponseData(responseData)) {
				const sessionData = {
					session: responseData.session,
					user: responseData.user,
				};
				const wasRefreshed =
					BETTER_AUTH_METHODS_CACHE.wasTokenRefreshed(sessionData);
				BETTER_AUTH_METHODS_CACHE.setCachedSession(sessionData);

				if (wasRefreshed) {
					emitAuthEvent({ type: "TOKEN_REFRESH", data: sessionData });
				}

				// remove the session verifier parameter from the URL if it exists on success
				if (isBrowser()) {
					const url = new URL(globalThis.window.location.href);
					const neonAuthSessionVerifierParam = url.searchParams.get(
						NEON_AUTH_SESSION_VERIFIER_PARAM_NAME,
					);
					if (neonAuthSessionVerifierParam) {
						url.searchParams.delete(
							NEON_AUTH_SESSION_VERIFIER_PARAM_NAME,
						);
						history.replaceState(history.state, "", url.href);
					}
				}
			}
		},
	},
	anonymousToken: {
		beforeFetch: () => {
			const cachedResponse =
				BETTER_AUTH_ANONYMOUS_TOKEN_CACHE.getCachedResponse();
			if (!cachedResponse) {
				return null;
			}

			return Response.json(cachedResponse, { status: 200 });
		},
		onRequest: () => {},
		onSuccess: (responseData) => {
			const parsed = anonymousTokenResponseSchema.safeParse(responseData);
			if (parsed.success) {
				BETTER_AUTH_ANONYMOUS_TOKEN_CACHE.setCachedResponse(
					parsed.data,
				);
			}
		},
	},
};

/**
 * Unified event emission method that handles Better Auth broadcasts.
 * Broadcasts use Better Auth native format - each adapter handles
 * conversion to their specific format (e.g., Supabase Session).
 *
 * This ensures:
 * - Single source of truth for all event emissions
 * - Better Auth ecosystem compatibility via getGlobalBroadcastChannel()
 * - Adapter-agnostic event format
 * - Cross-tab synchronization via Better Auth's broadcast system
 */
export async function emitAuthEvent(event: InternalAuthEvent): Promise<void> {
	const eventType = mapToEventType(event);
	const sessionData = "data" in event ? event.data : null;

	// Emit Better Auth broadcast for cross-tab sync + ecosystem compatibility
	const trigger = mapToTrigger(event);
	if (trigger) {
		getGlobalBroadcastChannel().post({
			event: "session",
			data: { trigger },
			clientId: CURRENT_TAB_CLIENT_ID,
		});
	}

	// Broadcast with Better Auth native format
	getGlobalBroadcastChannel().post({
		event: "session",
		data: { trigger: eventType, sessionData },
		clientId: CURRENT_TAB_CLIENT_ID,
	});
}

/** Maps internal event types to NeonAuthChangeEvent */
function mapToEventType(event: InternalAuthEvent): NeonAuthChangeEvent {
	switch (event.type) {
		case "SIGN_IN": {
			return "SIGNED_IN";
		}
		case "SIGN_OUT": {
			return "SIGNED_OUT";
		}
		case "TOKEN_REFRESH": {
			return "TOKEN_REFRESHED";
		}
		case "USER_UPDATE": {
			return "USER_UPDATED";
		}
	}
}

/** Maps internal event types to Better Auth broadcast triggers */
function mapToTrigger(
	event: InternalAuthEvent,
): "signout" | "getSession" | "updateUser" | null {
	switch (event.type) {
		case "SIGN_OUT": {
			return "signout";
		}
		case "TOKEN_REFRESH": {
			return null;
		}
		case "USER_UPDATE": {
			return "updateUser";
		}
		case "SIGN_IN": {
			return null; // No Better Auth broadcast for sign-in
		}
	}
}

/**
 * Type guard that validates response data has non-null session and user.
 * Narrows the type to ensure session and user are not null.
 */
function isSessionResponseData(
	responseData: unknown,
): responseData is { session: BetterAuthSession; user: BetterAuthUser } {
	return Boolean(
		responseData &&
			typeof responseData === "object" &&
			"session" in responseData &&
			"user" in responseData &&
			responseData.session !== null &&
			responseData.user !== null,
	);
}

export function deriveBetterAuthMethodFromUrl(
	url: string,
): keyof typeof BETTER_AUTH_METHODS_HOOKS | undefined {
	if (url.includes("/sign-in/anonymous")) {
		return "anonymousSignIn";
	}
	// Check for anonymous token BEFORE generic /token check
	if (url.includes(BETTER_AUTH_ENDPOINTS.anonymousToken)) {
		return "anonymousToken";
	}
	if (url.includes(BETTER_AUTH_ENDPOINTS.signIn)) {
		return "signIn";
	}
	if (url.includes(BETTER_AUTH_ENDPOINTS.signUp)) {
		return "signUp";
	}
	if (url.includes(BETTER_AUTH_ENDPOINTS.signOut)) {
		return "signOut";
	}
	if (url.includes(BETTER_AUTH_ENDPOINTS.updateUser)) {
		return "updateUser";
	}
	if (
		url.includes(BETTER_AUTH_ENDPOINTS.getSession) ||
		url.includes(BETTER_AUTH_ENDPOINTS.token)
	) {
		return "getSession";
	}
	return undefined;
}

export function initBroadcastChannel() {
	// Handle OAuth popup completion - send verifier to parent and close
	if (isBrowser() && globalThis.opener && globalThis.opener !== globalThis) {
		const params = new URLSearchParams(globalThis.location.search);
		if (params.has(NEON_AUTH_POPUP_PARAM_NAME)) {
			const verifier = params.get(NEON_AUTH_SESSION_VERIFIER_PARAM_NAME);
			const originalCallback = params.get(
				NEON_AUTH_POPUP_CALLBACK_PARAM_NAME,
			);
			globalThis.opener.postMessage(
				{ type: OAUTH_POPUP_MESSAGE_TYPE, verifier, originalCallback },
				"*",
			);
			globalThis.close();
			return;
		}
	}

	getGlobalBroadcastChannel().subscribe((message) => {
		if (message.clientId === CURRENT_TAB_CLIENT_ID) {
			return;
		}

		// Only clear cache for Better Auth triggers that cause internal getSession
		// This ensures getSession makes a real request instead of returning cached data
		const trigger = message.data?.trigger;
		if (
			trigger === "signout" ||
			trigger === "updateUser" ||
			trigger === "getSession"
		) {
			BETTER_AUTH_METHODS_CACHE.clearSessionCache();
		}
	});
}
