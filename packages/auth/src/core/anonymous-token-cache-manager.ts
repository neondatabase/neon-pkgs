import type { z } from "zod";
import type { anonymousTokenResponseSchema } from "../plugins/anonymous-token";
import { TokenCache } from "./token-cache";

export type AnonymousTokenResponseData = z.infer<
	typeof anonymousTokenResponseSchema
>;

/**
 * Manages in-memory anonymous token cache with TTL expiration.
 *
 * Stores the full anonymous token response (token + expires_at).
 * Unlike SessionCacheManager, doesn't need:
 * - Invalidation flag (no sign-out scenario for anonymous tokens)
 * - Refresh detection (anonymous tokens are stateless)
 */
export class AnonymousTokenCacheManager {
	private cache = new TokenCache<AnonymousTokenResponseData>();

	/**
	 * Get cached anonymous token response if not expired.
	 * Returns null if cache is empty or expired.
	 */
	getCachedResponse(): AnonymousTokenResponseData | null {
		return this.cache.get();
	}

	/**
	 * Set cached anonymous token response with JWT-based TTL.
	 * TTL is automatically calculated from the JWT expiration.
	 */
	setCachedResponse(data: AnonymousTokenResponseData): void {
		this.cache.set(data, data.token);
	}

	/**
	 * Clear the cache.
	 */
	clearCache(): void {
		this.cache.clear();
	}

	/**
	 * Check if cache has a valid (non-expired) response.
	 */
	hasCachedResponse(): boolean {
		return this.cache.has();
	}
}
