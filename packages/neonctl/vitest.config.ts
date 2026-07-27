import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			all: true,
			include: ["bin"],
			reporter: ["html", "lcov"],
		},
		exclude: ["node_modules"],
	},
});
