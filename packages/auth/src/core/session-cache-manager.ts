import type { BetterAuthSession, BetterAuthUser } from "./better-auth-types";
import { TokenCache } from "./token-cache";

/**
 * Cached session data in Better Auth native format.
 * The adapter is responsible for mapping to/from its specific format (e.g., Supabase).
 */
export type CachedSessionData = {
	session: BetterAuthSession;
	user: BetterAuthUser;
};

/**
 * Manages in-memory session cache with TTL expiration.
 *
 * Built on TokenCache, adding session-specific features:
 * - Invalidation flag for sign-out scenarios
 * - Token refresh detection via lastSessionData comparison
 *
 * Example:
 * ```typescript
 * const cacheManager = new SessionCacheManager();
 * cacheManager.setCachedSession({ session, user });
 * const cached = cacheManager.getCachedSession();
 * ```
 */
export class SessionCacheManager {
	private cache = new TokenCache<CachedSessionData>();
	private lastSessionData: CachedSessionData | null = null;
	private invalidated = false;

	/**
	 * Get cached session if valid and not expired.
	 * Returns null if cache is invalid, expired, or doesn't exist.
	 */
	getCachedSession(): CachedSessionData | null {
		if (this.invalidated) {
			return null;
		}

		return this.cache.get();
	}

	/**
	 * Set cached session with JWT-based TTL.
	 * Skips caching if cache was invalidated (sign-out scenario).
	 */
	setCachedSession(data: CachedSessionData): void {
		// Check if cache was invalidated (signOut called during in-flight request)
		if (this.invalidated) {
			return;
		}

		// Store current cache data as lastSessionData before updating
		this.lastSessionData = this.cache.get();

		this.cache.set(data, data.session.token);
	}

	/**
	 * Invalidate cache (marks as invalid but doesn't clear).
	 * Useful for sign-out scenarios where in-flight requests should not cache.
	 */
	invalidateSessionCache(): void {
		this.invalidated = true;
	}

	/**
	 * Clear cache completely.
	 */
	clearSessionCache(): void {
		this.cache.clear();
		this.lastSessionData = null;
		this.invalidated = false;
	}

	/**
	 * Check if token was refreshed by comparing tokens with previous session.
	 * Returns true if tokens differ (token was refreshed), false otherwise.
	 */
	wasTokenRefreshed(data: CachedSessionData): boolean {
		if (!this.lastSessionData?.session?.token || !data?.session?.token) {
			return false;
		}
		return this.lastSessionData.session.token !== data.session.token;
	}
}
