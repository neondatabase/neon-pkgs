import { defineConfig } from "vitest/config";

/**
 * Vitest config for end-to-end tests that spawn the built CLI against the **real** Neon
 * API. The default `vitest.config.ts` never picks these up: its include pattern is scoped
 * to the package's own `*.test.ts` files and this directory is excluded there.
 *
 * Long timeouts because each case shells out to a real binary that provisions real
 * infrastructure; single-threaded so the cases don't compete for quota.
 */
export default defineConfig({
	test: {
		include: ["e2e/**/*.test.ts"],
		exclude: ["node_modules", "dist"],
		setupFiles: ["./e2e/load-env.ts", "./e2e/setup.ts"],
		testTimeout: 180_000,
		hookTimeout: 180_000,
		pool: "forks",
		poolOptions: {
			forks: {
				singleFork: true,
			},
		},
		reporters: ["verbose"],
	},
});
