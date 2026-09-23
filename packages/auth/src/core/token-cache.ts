import { getJwtExpiration } from "../utils/jwt";
import { CLOCK_SKEW_BUFFER_MS, SESSION_CACHE_TTL_MS } from "./constants";

type CacheEntry<T> = {
	data: T;
	expiresAt: number;
};

export class TokenCache<T> {
	private cache: CacheEntry<T> | null = null;

	/**
	 * Get cached data if not expired.
	 * Returns null if cache is empty or expired.
	 */
	get(): T | null {
		if (!this.cache) {
			return null;
		}

		if (Date.now() > this.cache.expiresAt) {
			this.cache = null;
			return null;
		}

		return this.cache.data;
	}

	/**
	 * Set cached data with TTL.
	 * If jwt is provided, TTL is calculated from its expiration.
	 * Otherwise, uses default SESSION_CACHE_TTL_MS.
	 */
	set(data: T, jwt?: string): void {
		const ttl = this.calculateTTL(jwt);
		this.cache = {
			data,
			expiresAt: Date.now() + ttl,
		};
	}

	/**
	 * Clear the cache.
	 */
	clear(): void {
		this.cache = null;
	}

	/**
	 * Check if cache has valid (non-expired) data.
	 */
	has(): boolean {
		return this.get() !== null;
	}

	/**
	 * Calculate cache TTL from JWT expiration.
	 * Falls back to default TTL if JWT is invalid or missing.
	 */
	private calculateTTL(jwt: string | undefined): number {
		if (!jwt) {
			return SESSION_CACHE_TTL_MS;
		}

		const exp = getJwtExpiration(jwt);
		if (!exp) {
			return SESSION_CACHE_TTL_MS;
		}

		const now = Date.now();
		const expiresAtMs = exp * 1000;
		const ttl = expiresAtMs - now - CLOCK_SKEW_BUFFER_MS;

		// Ensure minimum TTL of 1 second
		return Math.max(ttl, 1000);
	}
}
