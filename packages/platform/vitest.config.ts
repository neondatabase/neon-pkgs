import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		clearMocks: true,
		mockReset: true,
		coverage: {
			all: true,
			include: ["src"],
			exclude: ["src/**/*.test.ts", "src/lib/fake-neon-api.ts"],
			reporter: ["html", "lcov"],
		},
		exclude: ["lib", "node_modules", "dist"],
		setupFiles: ["console-fail-test/setup"],
	},
});
