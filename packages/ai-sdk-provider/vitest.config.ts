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
		// `e2e/**/*.e2e.test.ts` needs a live gateway and runs from vitest.e2e.config.ts.
		// Anything else under `e2e/` that is a plain `*.test.ts` is a unit test of the
		// suite's own plumbing — `gateway-url.test.ts` covers the host derivation — and
		// belongs in this fast, network-free run.
		exclude: ["lib", "node_modules", "dist", "**/*.e2e.test.ts"],
		setupFiles: ["console-fail-test/setup"],
	},
});
