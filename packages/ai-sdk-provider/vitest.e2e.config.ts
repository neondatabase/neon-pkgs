import { defineConfig } from "vitest/config";

/**
 * End-to-end tests against a live Neon AI Gateway branch.
 *
 * `e2e/global-setup.ts` supplies the gateway: either the `NEON_AI_GATEWAY_BASE_URL` +
 * `NEON_AI_GATEWAY_TOKEN` pair you configured, or a throwaway project it creates from
 * `NEON_API_KEY` and deletes afterwards (see `.env.example`). There is no third path — a run
 * with neither fails instead of skipping.
 */
export default defineConfig({
	test: {
		include: ["e2e/**/*.e2e.test.ts"],
		exclude: ["node_modules", "dist"],
		globalSetup: ["./e2e/global-setup.ts"],
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
