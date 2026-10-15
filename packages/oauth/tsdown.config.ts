import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neon/oauth",
	bundle: true,
	clean: true,
	dts: true,
	entry: [
		"src/index.ts",
		"src/verify/index.ts",
		"src/adapter.ts",
		"src/hono.ts",
		"src/express.ts",
		"src/next.ts",
		"src/node.ts",
		"src/mcp/index.ts",
		"src/mcp/hono.ts",
		"src/mcp/express.ts",
		"src/mcp/next.ts",
		"src/mcp/node.ts",
	],
	format: "esm",
	// Entry file names must be stable because package.json `exports` points at them. Without
	// `hash: false` they gain a hash suffix; with it, a shared chunk named after an entry (the
	// declarations for `index`, `adapter`, `node`) steals that file name and pushes the real
	// entry to `<name>2`. Shared chunks therefore live under `_chunks/`, where they cannot collide.
	hash: false,
	outputOptions: {
		chunkFileNames: (chunk) =>
			chunk.isEntry ? "[name].js" : "_chunks/[name]-[hash].js",
	},
	outDir: "dist",
	treeshake: true,
	// Package imports stay runtime imports; only relative modules are bundled.
	external: (id) =>
		!id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0"),
});
