import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["e2e/**/*.test.ts"],
		exclude: ["node_modules", "dist"],
		setupFiles: ["./e2e/load-env.ts", "./e2e/setup.ts"],
		testTimeout: 180_000,
		hookTimeout: 180_000,
		pool: "forks",
		poolOptions: {
			forks: {
				singleFork: true,
			},
		},
		reporters: ["verbose"],
	},
});
