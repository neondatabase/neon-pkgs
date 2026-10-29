import type { SessionData } from "../types";

/**
 * Default list of route prefixes that {@link processAuthMiddleware} skips when
 * deciding whether to enforce authentication. Includes the auth API mount
 * (`/api/auth`) and the auth pages a signed-out user has to reach: the
 * `@neondatabase/auth-ui` pages and the `@better-auth-ui/react` 1.7 auth views
 * (core `viewPaths.auth` plus the magic-link, email-OTP, two-factor,
 * phone-number and organization invitation plugin views) under their default
 * `/auth` base path.
 *
 * The list is explicit on purpose: `/auth` as a whole is not public, and
 * `/settings/*` views stay protected.
 *
 * Framework adapters use this as the default for their middleware integrations.
 * Application authors can compose it with their own public routes:
 *
 * ```ts
 * import { DEFAULT_AUTH_SKIP_ROUTES } from '@neon/auth/server';
 *
 * const SKIP_ROUTES = [...DEFAULT_AUTH_SKIP_ROUTES, '/marketing', '/healthz'];
 * ```
 *
 * @public
 */
export const DEFAULT_AUTH_SKIP_ROUTES = [
	"/api/auth",
	"/auth/callback",
	"/auth/sign-in",
	"/auth/sign-up",
	"/auth/magic-link",
	"/auth/magic-link-sent",
	"/auth/email-otp",
	"/auth/two-factor",
	"/auth/phone-number",
	"/auth/phone-number-forgot-password",
	"/auth/phone-number-reset-password",
	"/auth/forgot-password",
	"/auth/reset-password",
	"/auth/reset-link-sent",
	"/auth/verify-email",
	"/auth/sign-out",
	"/auth/error",
	"/auth/redirect",
	"/auth/accept-invitation",
] as const;

/**
 * Checks if a given pathname should be protected (require authentication)
 *
 * @param pathname - URL pathname to check
 * @param skipRoutes - Exact routes and their slash-delimited subpaths to skip protection
 * @returns true if route should be protected, false if it should be skipped
 */
export function shouldProtectRoute(
	pathname: string,
	skipRoutes: readonly string[],
): boolean {
	return !skipRoutes.some((route) => isSamePathOrSubpath(pathname, route));
}

export function isSamePathOrSubpath(
	pathname: string,
	routePathname: string,
): boolean {
	const normalizedRoutePathname =
		routePathname === "/"
			? routePathname
			: routePathname.replace(/\/+$/, "");

	if (pathname === normalizedRoutePathname) {
		return true;
	}

	return (
		normalizedRoutePathname !== "/" &&
		pathname.startsWith(`${normalizedRoutePathname}/`)
	);
}

/**
 * Result of session requirement check
 */
export interface SessionCheckResult {
	/** Whether the request is allowed to proceed */
	allowed: boolean;
	/** Session data if authenticated */
	session?: SessionData;
	/** Whether redirect is needed (only relevant if not allowed) */
	requiresRedirect: boolean;
}

/**
 * Checks if the current request requires a valid session
 * Returns result indicating if request should proceed, redirect, or continue
 *
 * @param pathname - URL pathname being accessed
 * @param skipRoutes - Routes that don't require authentication
 * @param loginPathname - Same-origin login pathname, or null for an external login URL
 * @param session - Current session data (null if not authenticated)
 * @returns Session check result
 */
export function checkSessionRequired(
	pathname: string,
	skipRoutes: readonly string[],
	loginPathname: string | null,
	session: SessionData | null,
): SessionCheckResult {
	// Always allow access to login URL to prevent infinite redirect
	if (
		loginPathname !== null &&
		isSamePathOrSubpath(pathname, loginPathname)
	) {
		return { allowed: true, requiresRedirect: false };
	}

	// Check if route should be protected
	if (!shouldProtectRoute(pathname, skipRoutes)) {
		return { allowed: true, requiresRedirect: false };
	}

	// Route requires protection - check if session exists
	if (!session || session.session === null) {
		return { allowed: false, requiresRedirect: true };
	}

	// Valid session exists
	return { allowed: true, session, requiresRedirect: false };
}
