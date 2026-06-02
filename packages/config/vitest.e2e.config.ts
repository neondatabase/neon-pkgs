import { defineConfig } from "vitest/config";

/**
 * Vitest config for end-to-end tests that hit the **real** Neon API.
 *
 * - Matches `**\/*.e2e.test.ts` only — the standard `test:ci` config explicitly excludes
 *   this pattern so the two suites never collide.
 * - Uses long per-test timeouts because real project creation / deletion can take 10+s.
 * - Forces single-threaded execution to avoid quota / rate-limit interference between
 *   tests (`pool: "forks"` with `singleFork: true`).
 * - Loads `.env` via Vitest's built-in dotenv support so `NEON_API_KEY` (and optionally
 *   `NEON_ORG_ID`) become `process.env` entries inside the tests.
 */
export default defineConfig({
	test: {
		include: ["src/**/*.e2e.test.ts", "e2e/**/*.test.ts"],
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
