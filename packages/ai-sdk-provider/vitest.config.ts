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
		exclude: ["lib", "node_modules", "dist", "e2e", "**/*.e2e.test.ts"],
		setupFiles: ["console-fail-test/setup"],
	},
});
