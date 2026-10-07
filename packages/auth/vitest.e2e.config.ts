import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

/**
 * End-to-end tests against a live Neon Auth service.
 *
 * `e2e/global-setup.ts` supplies it: a throwaway project created from `NEON_API_KEY`,
 * Neon Auth enabled on its default branch with email verification off — the only way a
 * headless signup can succeed — and `NEON_AUTH_BASE_URL` / `NEON_AUTH_JWKS_URL` set for
 * every test file. There is no credentials-free mode, because a green run of zero tests
 * is exactly the failure this suite exists to prevent.
 *
 * `tsconfigPaths` mirrors `vitest.config.ts` because the src tree the tests import
 * resolves its own `@/*` imports through the tsconfig alias.
 */
export default defineConfig({
	plugins: [tsconfigPaths()],
	test: {
		include: ["e2e/**/*.e2e.test.ts"],
		exclude: ["node_modules", "dist"],
		globalSetup: ["./e2e/global-setup.ts"],
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
