import { describe, expect, it } from "vitest";
import {
	formatUpdateNotice,
	parseUpdateCheckCache,
	shouldRefreshUpdateCheck,
	shouldRunUpdateNotifier,
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
		"/tmp/neon/dist/update_notifier.js",
	])("suppresses unknown and transient installs at %s", (modulePath) => {
		expect(recommendedCliUpgradeCommand(modulePath)).toBeUndefined();
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
				}),
			),
		).toEqual({
			checkedAt: 100,
			latestVersion: "5.1.0",
			notifiedAt: 200,
		});
	});

	it.each([
		"",
		"{}",
		'{"checkedAt":"100"}',
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
				{ checkedAt: 0, latestVersion: "5.0.1" },
				day,
			),
		).toBe(true);
	});

	it("keeps a daily check fresh", () => {
		expect(
			shouldRefreshUpdateCheck(
				{ checkedAt: 1, latestVersion: "5.0.1" },
				day,
			),
		).toBe(false);
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
	])("suppresses $commandPath when ineligible", (override) => {
		expect(shouldRunUpdateNotifier({ ...eligible, ...override })).toBe(
			false,
		);
	});
});
