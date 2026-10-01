import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		clearMocks: true,
		mockReset: true,
		unstubEnvs: true,
		coverage: {
			all: true,
			include: ["src"],
			exclude: ["src/**/*.test.ts", "src/**/*.test-d.ts"],
			reporter: ["html", "lcov"],
		},
		exclude: ["e2e", "node_modules", "dist"],
		setupFiles: ["console-fail-test/setup"],
		typecheck: {
			enabled: true,
			include: ["src/**/*.test-d.ts"],
		},
	},
});
