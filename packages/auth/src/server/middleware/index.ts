/**
 * Framework-agnostic middleware utilities for Neon Auth
 *
 * These utilities provide core middleware functionality that can be
 * used across different server frameworks (Next.js, Remix, SvelteKit, etc.)
 */

export {
	exchangeOAuthToken,
	needsSessionVerification,
	type OAuthExchangeResult,
} from "./oauth";
export {
	type AuthMiddlewareConfig,
	type MiddlewareResult,
	processAuthMiddleware,
} from "./processor";
export {
	checkSessionRequired,
	DEFAULT_AUTH_SKIP_ROUTES,
	type SessionCheckResult,
	shouldProtectRoute,
} from "./route-protection";
