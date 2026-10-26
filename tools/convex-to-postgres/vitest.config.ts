import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		clearMocks: true,
		mockReset: true,
		unstubEnvs: true,
		coverage: {
			all: true,
			include: ["src"],
			exclude: [
				"src/**/*.test.ts",
				"src/test-fixtures.ts",
				// Exercised only by the Phase B integration suite (needs a live
				// Postgres), so it is not covered by the pure unit run.
				"src/data/import.ts",
				"src/data/read-export.ts",
				"src/schema/load.ts",
			],
			reporter: ["html", "lcov"],
		},
		// Integration tests talk to a real Postgres via testcontainers (Docker).
		// They run only through `pnpm test:integration` against
		// `vitest.integration.config.ts`, never in the default CI suite.
		exclude: [
			"node_modules",
			"dist",
			"integration/**",
			"**/*.integration.test.ts",
		],
	},
});
