/**
 * Generic in-flight request deduplication manager.
 *
 * Prevents thundering herd by tracking Promises by key.
 * Multiple concurrent calls with the same key await the same Promise
 * instead of making N identical requests.
 *
 * Example:
 * ```typescript
 * const manager = new InFlightRequestManager();
 *
 * // 10 concurrent calls deduplicate to 1 actual fetch
 * const results = await Promise.all([
 *   manager.deduplicate('user:123', () => fetchUser(123)),
 *   manager.deduplicate('user:123', () => fetchUser(123)),
 *   // ... 8 more calls
 * ]);
 * // Result: 1 fetch call, 10 identical results
 * ```
 *
 * Thread Safety: JavaScript is single-threaded, no race conditions possible
 */
export class InFlightRequestManager {
	/**
	 * Map of request keys to in-flight Promises.
	 * Automatically cleared after Promise resolution (success or error).
	 */
	private inFlightRequests = new Map<string, Promise<unknown>>();

	/**
	 * Execute function with deduplication.
	 *
	 * If request with same key is in-flight, returns existing Promise.
	 * Otherwise, executes fn and tracks the Promise.
	 *
	 * @param key - Unique identifier for this request (e.g., "getSession")
	 * @param fn - Async function to execute (only called if no in-flight request exists)
	 * @returns Promise that resolves to the function result
	 *
	 * @example
	 * ```typescript
	 * // First call: Executes fetchSession(), tracks Promise
	 * const result1 = await manager.deduplicate('getSession', fetchSession);
	 *
	 * // Concurrent call: Returns existing Promise (no fetchSession() call)
	 * const result2 = await manager.deduplicate('getSession', fetchSession);
	 *
	 * // Both results are identical (same object reference)
	 * console.log(result1 === result2); // true
	 * ```
	 */
	async deduplicate<T>(key: string, fn: () => Promise<T>): Promise<T> {
		// Check if request is already in-flight
		const existing = this.inFlightRequests.get(key);
		if (existing) {
			return existing as Promise<T>;
		}

		// Create new tracked Promise
		const promise = fn().finally(() => {
			// Clear after resolution (success or error) to allow retry
			this.inFlightRequests.delete(key);
		});

		// Track Promise before returning
		this.inFlightRequests.set(key, promise);

		return promise;
	}

	/**
	 * Clear specific in-flight request.
	 *
	 * Useful for forced refresh or cache invalidation scenarios.
	 * Next call with same key will execute fresh request.
	 *
	 * @param key - Request key to clear
	 */
	clear(key: string): void {
		this.inFlightRequests.delete(key);
	}

	/**
	 * Clear all in-flight requests.
	 *
	 * Useful for cleanup on sign-out or reset scenarios.
	 */
	clearAll(): void {
		this.inFlightRequests.clear();
	}

	/**
	 * Check if request is in-flight.
	 *
	 * @param key - Request key to check
	 * @returns True if request is currently in-flight
	 */
	has(key: string): boolean {
		return this.inFlightRequests.has(key);
	}

	/**
	 * Get count of in-flight requests (for debugging/testing).
	 *
	 * @returns Number of currently tracked requests
	 */
	size(): number {
		return this.inFlightRequests.size;
	}
}
