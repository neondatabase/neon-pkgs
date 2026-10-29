import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { describe, expect, it } from "vitest";
import { SUPPORTED_SPECIFIER } from "./utils/better-auth-version";

type PackageJson = {
	version?: string;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "..");
const readJson = (file: string) =>
	JSON.parse(readFileSync(file, "utf8")) as PackageJson;

const ownPkg = readJson(path.join(packageRoot, "package.json"));
const providerPeers =
	readJson(
		path.join(
			packageRoot,
			"node_modules",
			"@better-auth",
			"oauth-provider",
			"package.json",
		),
	).peerDependencies ?? {};

const installedVersion = (name: string) =>
	readJson(
		path.join(
			packageRoot,
			"node_modules",
			...name.split("/"),
			"package.json",
		),
	).version as string;

describe("@neon/auth dependency shape", () => {
	it("declares every @better-auth/oauth-provider peer as a direct dependency", () => {
		expect(Object.keys(providerPeers).length).toBeGreaterThan(0);
		for (const peer of Object.keys(providerPeers)) {
			expect(ownPkg.dependencies, peer).toHaveProperty([peer]);
		}
	});

	it("declares ranges that intersect every @better-auth/oauth-provider peer range", () => {
		for (const [peer, peerRange] of Object.entries(providerPeers)) {
			const ours = ownPkg.dependencies?.[peer];
			expect(
				ours,
				`${peer} must be declared in dependencies`,
			).toBeDefined();
			if (ours === undefined) continue;
			expect(
				semver.intersects(ours, peerRange),
				`${peer}: ${ours} vs ${peerRange}`,
			).toBe(true);
		}
	});

	it("installs a version of every peer that satisfies both ranges", () => {
		for (const [peer, peerRange] of Object.entries(providerPeers)) {
			const ours = ownPkg.dependencies?.[peer];
			expect(
				ours,
				`${peer} must be declared in dependencies`,
			).toBeDefined();
			if (ours === undefined) continue;
			const installed = installedVersion(peer);
			expect(
				semver.satisfies(installed, ours),
				`${peer}@${installed} vs ${ours}`,
			).toBe(true);
			expect(
				semver.satisfies(installed, peerRange),
				`${peer}@${installed} vs ${peerRange}`,
			).toBe(true);
		}
	});

	it.each([
		"better-auth",
		"@better-auth/core",
		"@better-auth/oauth-provider",
	])("declares %s as a ~ or bare-version range", (name) => {
		expect(ownPkg.dependencies?.[name]).toMatch(SUPPORTED_SPECIFIER);
	});
});
