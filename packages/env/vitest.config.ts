import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		clearMocks: true,
		mockReset: true,
		unstubEnvs: true,
		coverage: {
			all: true,
			include: ["src"],
			exclude: ["src/**/*.test.ts"],
			reporter: ["html", "lcov"],
		},
		// Skip e2e tests (which talk to the real Neon API) in the standard suite — they
		// run via `pnpm test:e2e` against `vitest.e2e.config.ts`.
		exclude: ["lib", "node_modules", "dist", "**/*.e2e.test.ts", "e2e/**"],
		setupFiles: ["console-fail-test/setup"],
	},
});
