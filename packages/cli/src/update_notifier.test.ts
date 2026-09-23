import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	cacheForUpdateSource,
	formatUpdateNotice,
	parseUpdateCheckCache,
	shouldRefreshUpdateCheck,
	shouldRunUpdateNotifier,
	spawnUpdateWorkerProcess,
	type UpdateCheckCache,
	writeUpdateCheckCache,
} from "./update_notifier.js";
import { recommendedCliUpgradeCommand } from "./utils/package_manager.js";

describe("recommendedCliUpgradeCommand", () => {
	it.each([
		[
			"/opt/homebrew/Cellar/neonctl/5.0.1/libexec/lib/node_modules/neon/dist/update_notifier.js",
			"brew upgrade neonctl",
		],
		[
			"/home/linuxbrew/.linuxbrew/Cellar/neonctl/5.0.1/libexec/lib/node_modules/neon/dist/update_notifier.js",
			"brew upgrade neonctl",
		],
		[
			"/Users/user/.nvm/versions/node/v22.20.0/lib/node_modules/neon/dist/update_notifier.js",
			"npm i -g neon@latest",
		],
		[
			"C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\neon\\dist\\update_notifier.js",
			"npm i -g neon@latest",
		],
		[
			"/Users/user/Library/pnpm/global/5/.pnpm/neon@5.0.1/node_modules/neon/dist/update_notifier.js",
			"pnpm i -g neon@latest",
		],
		[
			"/Users/user/.bun/install/global/node_modules/neon/dist/update_notifier.js",
			"bun i -g neon@latest",
		],
	])("maps %s to its installer", (modulePath, expected) => {
		expect(recommendedCliUpgradeCommand(modulePath)).toBe(expected);
	});

	it.each([
		"/repo/node_modules/neon/dist/update_notifier.js",
		"/Users/user/.npm/_npx/abc/node_modules/neon/dist/update_notifier.js",
		"/repo/node_modules/.pnpm/neon@5.0.1/node_modules/neon/dist/update_notifier.js",
		"/Users/user/Library/Caches/pnpm/dlx/hash/node_modules/.pnpm/neon@5.0.1/node_modules/neon/dist/update_notifier.js",
		"/tmp/neon/dist/update_notifier.js",
	])("suppresses unknown and transient installs at %s", (modulePath) => {
		expect(recommendedCliUpgradeCommand(modulePath)).toBeUndefined();
	});
});

describe("spawnUpdateWorkerProcess", () => {
	it("handles a missing executable without an unhandled error", async () => {
		const child = spawnUpdateWorkerProcess({
			cachePath: "/tmp/neon-update-cache",
			executablePath: "/path/that/does/not/exist/node",
			source: "npm",
			workerPath: "/tmp/neon-update-worker.js",
		});

		const [error] = await once(child, "error");
		expect(error).toBeInstanceOf(Error);
	});
});

describe("formatUpdateNotice", () => {
	it("prints only the version warning and upgrade command", () => {
		expect(
			formatUpdateNotice({
				currentVersion: "5.0.1",
				latestVersion: "5.1.0",
				upgradeCommand: "npm i -g neon@latest",
			}),
		).toBe(
			"Neon CLI update available: 5.0.1 → 5.1.0\nnpm i -g neon@latest",
		);
	});

	it.each([
		["5.0.1", "5.0.1"],
		["5.1.0", "5.0.1"],
		["5.0.1", "invalid"],
		["invalid", "5.1.0"],
	])("suppresses a notice for current %s and latest %s", (currentVersion, latestVersion) => {
		expect(
			formatUpdateNotice({
				currentVersion,
				latestVersion,
				upgradeCommand: "npm i -g neon@latest",
			}),
		).toBeUndefined();
	});
});

describe("parseUpdateCheckCache", () => {
	it("accepts a complete cache", () => {
		expect(
			parseUpdateCheckCache(
				JSON.stringify({
					checkedAt: 100,
					latestVersion: "5.1.0",
					notifiedAt: 200,
					source: "npm",
				}),
			),
		).toEqual({
			checkedAt: 100,
			latestVersion: "5.1.0",
			notifiedAt: 200,
			source: "npm",
		});
	});

	it.each([
		"",
		"{}",
		'{"checkedAt":100}',
		'{"checkedAt":"100"}',
		'{"checkedAt":100,"source":"other"}',
		'{"checkedAt":100,"latestVersion":1}',
		'{"checkedAt":100,"notifiedAt":"200"}',
	])("rejects malformed cache data: %s", (raw) => {
		expect(parseUpdateCheckCache(raw)).toBeUndefined();
	});
});

describe("shouldRefreshUpdateCheck", () => {
	const day = 24 * 60 * 60 * 1000;

	it("refreshes a missing or expired cache", () => {
		expect(shouldRefreshUpdateCheck(undefined, day)).toBe(true);
		expect(
			shouldRefreshUpdateCheck(
				{ checkedAt: 0, latestVersion: "5.0.1", source: "npm" },
				day,
			),
		).toBe(true);
	});

	it("keeps a daily check fresh", () => {
		expect(
			shouldRefreshUpdateCheck(
				{ checkedAt: 1, latestVersion: "5.0.1", source: "npm" },
				day,
			),
		).toBe(false);
	});
});

describe("cacheForUpdateSource", () => {
	const cache: UpdateCheckCache = {
		checkedAt: 100,
		latestVersion: "5.1.0",
		notifiedAt: 200,
		source: "npm",
	};

	it("reuses cache state from the same release channel", () => {
		expect(cacheForUpdateSource(cache, "npm")).toEqual(cache);
	});

	it("discards version and timing state from another release channel", () => {
		expect(cacheForUpdateSource(cache, "homebrew")).toBeUndefined();
	});
});

describe("writeUpdateCheckCache", () => {
	it("contains cache write and cleanup failures", () => {
		const directory = mkdtempSync(join(tmpdir(), "neon-update-cache-"));
		const parentFile = join(directory, "not-a-directory");
		writeFileSync(parentFile, "");

		try {
			expect(() =>
				writeUpdateCheckCache(join(parentFile, "update-check.json"), {
					checkedAt: 100,
					source: "npm",
				}),
			).not.toThrow();
			expect(
				writeUpdateCheckCache(join(parentFile, "update-check.json"), {
					checkedAt: 100,
					source: "npm",
				}),
			).toBe(false);
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});
});

describe("shouldRunUpdateNotifier", () => {
	const eligible = {
		commandPath: ["projects", "list"],
		currentBranch: false,
		disabled: false,
		isCi: false,
		isPackaged: false,
		output: "table",
		stderrIsTty: true,
		stdoutIsTty: true,
		succeeded: true,
	};

	it("runs for an interactive human command", () => {
		expect(shouldRunUpdateNotifier(eligible)).toBe(true);
	});

	it.each([
		{ isCi: true },
		{ disabled: true },
		{ isPackaged: true },
		{ output: "json" },
		{ output: "yaml" },
		{ stdoutIsTty: false },
		{ stderrIsTty: false },
		{ commandPath: [] },
		{ commandPath: ["completion"] },
		{ commandPath: ["status"], currentBranch: true },
		{ commandPath: ["config", "status"], currentBranch: true },
		{ commandPath: ["config", "plan"], succeeded: false },
	])("suppresses $commandPath when ineligible", (override) => {
		expect(shouldRunUpdateNotifier({ ...eligible, ...override })).toBe(
			false,
		);
	});
});
