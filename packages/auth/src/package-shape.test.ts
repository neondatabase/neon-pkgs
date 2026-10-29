import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readJson = (path: string) =>
	JSON.parse(readFileSync(path, "utf8")) as {
		dependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	};

const ownPkg = readJson(join(__dirname, "..", "package.json"));
const providerPeers = Object.keys(
	readJson(
		join(
			__dirname,
			"..",
			"node_modules",
			"@better-auth",
			"oauth-provider",
			"package.json",
		),
	).peerDependencies ?? {},
);

describe("@neon/auth dependency shape", () => {
	it("declares every @better-auth/oauth-provider peer as a direct dependency", () => {
		expect(providerPeers.length).toBeGreaterThan(0);
		for (const peer of providerPeers) {
			expect(ownPkg.dependencies, peer).toHaveProperty([peer]);
		}
	});

	it.each([
		"better-auth",
		"@better-auth/core",
		"@better-auth/oauth-provider",
	])("declares %s as a ~ or bare-version range", (name) => {
		expect(ownPkg.dependencies?.[name]).toMatch(/^~?\d+\.\d+\.\d+$/);
	});
});
