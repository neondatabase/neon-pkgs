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
				"src/generated/**",
				"src/operations.gen.ts",
				"src/descriptions.gen.ts",
			],
			reporter: ["html", "lcov"],
		},
		exclude: ["lib", "node_modules", "dist", "e2e"],
		setupFiles: ["console-fail-test/setup"],
	},
});
