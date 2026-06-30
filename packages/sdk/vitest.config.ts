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
				"src/**/*.test-d.ts",
				"src/client/**",
			],
			reporter: ["html", "lcov"],
		},
		exclude: ["lib", "node_modules", "dist", "e2e"],
		setupFiles: ["console-fail-test/setup"],
	},
});
