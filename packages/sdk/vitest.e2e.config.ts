import { defineConfig } from "vitest/config";

/**
 * Vitest config for end-to-end tests that hit the **real** Neon API.
 *
 * - Matches `e2e/**\/*.test.ts` only — the standard `vitest.config.ts` excludes `e2e`, so
 *   the fetch-stubbed unit suite and this one never collide.
 * - Long per-test timeouts: real project creation plus readiness polling takes 10s+.
 * - Single-threaded (`pool: "forks"`, `singleFork: true`) so tests don't compete for
 *   quota or trip rate limits.
 */
export default defineConfig({
	test: {
		include: ["e2e/**/*.test.ts"],
		exclude: ["node_modules", "dist"],
		setupFiles: ["./e2e/load-env.ts", "./e2e/setup.ts"],
		testTimeout: 120_000,
		hookTimeout: 120_000,
		pool: "forks",
		poolOptions: {
			forks: {
				singleFork: true,
			},
		},
		reporters: ["verbose"],
	},
});
