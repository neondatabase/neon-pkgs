import { defineConfig } from "vitest/config";

/**
 * End-to-end tests against a live Neon AI Gateway branch.
 *
 * Requires `NEON_AI_GATEWAY_BASE_URL` + `NEON_AI_GATEWAY_TOKEN` (see `.env.example`).
 * Excluded from `test:ci` — run locally or in a gated workflow with secrets.
 */
export default defineConfig({
	test: {
		include: ["e2e/**/*.e2e.test.ts"],
		exclude: ["node_modules", "dist"],
		setupFiles: ["./e2e/load-env.ts"],
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
