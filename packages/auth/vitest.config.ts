import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [tsconfigPaths()],
	test: {
		environment: "node",
		// `e2e/` talks to a live Neon Auth service (see vitest.e2e.config.ts); leaving it
		// to Vitest's default glob would collect those files on every `test:ci`, which CI
		// runs on each pull request, and silently hit the real API.
		exclude: ["node_modules", "dist", "e2e"],
	},
});
