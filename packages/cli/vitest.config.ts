import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		setupFiles: ["./test-setup.ts"],
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"tests/psql-conformance/**",
			// Live Neon suite — needs credentials and a throwaway org.
			// Run it with `pnpm --filter neon test:e2e`.
			"e2e/**",
		],
	},
});
