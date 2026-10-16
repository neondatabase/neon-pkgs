// The jose-only entry points must stay free of the sign-in client. A resource server (an MCP
// server, an API) should not pay for `openid-client` just because it verifies tokens.
import { fileURLToPath } from "node:url";

import { rolldown } from "rolldown";
import { describe, expect, it } from "vitest";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Every module id that ends up in a full (nothing external) bundle of `entry`. */
async function bundledModules(entry: string): Promise<string[]> {
	const bundle = await rolldown({
		input: src(entry),
		platform: "node",
		logLevel: "silent",
	});
	try {
		const { output } = await bundle.generate({ format: "esm" });
		return output.flatMap((chunk) =>
			chunk.type === "chunk" ? chunk.moduleIds : [],
		);
	} finally {
		await bundle.close();
	}
}

const FORBIDDEN = [
	/[\\/]node_modules[\\/].*openid-client/,
	/[\\/]src[\\/]client[\\/]/,
	/[\\/]src[\\/]index\.ts$/,
];

describe.each([
	"./verify/index.ts",
	"./mcp/index.ts",
	"./mcp/hono.ts",
	"./mcp/express.ts",
	"./mcp/next.ts",
	"./mcp/node.ts",
])("%s bundle", (entry) => {
	it("contains no openid-client and no sign-in client module", async () => {
		const modules = await bundledModules(entry);
		expect(modules.length).toBeGreaterThan(0);
		expect(
			modules.filter((id) => FORBIDDEN.some((re) => re.test(id))),
		).toEqual([]);
	});
});

describe("root entry bundle", () => {
	it("does contain the sign-in client (the check above can fail)", async () => {
		const modules = await bundledModules("./index.ts");
		expect(modules.some((id) => /openid-client/.test(id))).toBe(true);
		expect(
			modules.some((id) => /[\\/]src[\\/]client[\\/]index\.ts$/.test(id)),
		).toBe(true);
	});
});
