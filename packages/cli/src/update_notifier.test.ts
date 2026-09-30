import { once } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cacheForUpdateSource,
	findCliInstalls,
	formatDuplicateInstallNotice,
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

describe("findCliInstalls", () => {
	const roots: string[] = [];
	afterEach(() => {
		while (roots.length > 0) {
			rmSync(roots.pop() ?? "", { force: true, recursive: true });
		}
	});

	const scratch = (): string => {
		const root = mkdtempSync(join(tmpdir(), "neon-installs-"));
		roots.push(root);
		return root;
	};

	/** A real executable at `root/target`, linked from `root/bin/<name>` for each name. */
	const install = (
		root: string,
		target: string,
		bin: string,
		names = ["neon"],
	): string => {
		const file = join(root, target);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
		const binDir = join(root, bin);
		mkdirSync(binDir, { recursive: true });
		for (const name of names) symlinkSync(file, join(binDir, name));
		return binDir;
	};

	const HOMEBREW =
		"brew/Cellar/neonctl/6.3.0/libexec/lib/node_modules/neonctl/bin/cli.js";
	const NPM = "npm/lib/node_modules/neon/dist/cli.js";

	it("lists each install in PATH order with its installer", () => {
		const root = scratch();
		const brew = install(root, HOMEBREW, "brew/bin");
		const npm = install(root, NPM, "npm/bin");

		expect(findCliInstalls("neon", [brew, npm].join(delimiter))).toEqual([
			{ method: "homebrew", path: join(brew, "neon") },
			{ method: "npm", path: join(npm, "neon") },
		]);
	});

	it("counts a repeated PATH directory and a second link to one file once", () => {
		const root = scratch();
		const brew = install(root, HOMEBREW, "brew/bin");
		const opt = join(root, "brew/opt/neonctl/bin");
		mkdirSync(opt, { recursive: true });
		symlinkSync(join(brew, "neon"), join(opt, "neon"));

		expect(
			findCliInstalls("neon", [brew, opt, brew].join(delimiter)),
		).toEqual([{ method: "homebrew", path: join(brew, "neon") }]);
	});

	it("keeps an install whose installer is unknown", () => {
		const root = scratch();
		const npm = install(root, NPM, "npm/bin");
		const standalone = install(root, "standalone/neon", "usr/local/bin");

		expect(
			findCliInstalls("neon", [npm, standalone].join(delimiter)),
		).toEqual([
			{ method: "npm", path: join(npm, "neon") },
			{ method: undefined, path: join(standalone, "neon") },
		]);
	});

	it("ignores non-executable files and broken links", () => {
		const root = scratch();
		const npm = install(root, NPM, "npm/bin");
		const other = join(root, "other/bin");
		mkdirSync(other, { recursive: true });
		writeFileSync(join(other, "neon"), "", { mode: 0o644 });
		const broken = join(root, "broken/bin");
		mkdirSync(broken, { recursive: true });
		symlinkSync(join(root, "missing"), join(broken, "neon"));

		expect(
			findCliInstalls("neon", [other, broken, npm].join(delimiter)),
		).toEqual([{ method: "npm", path: join(npm, "neon") }]);
	});

	it("finds nothing on an empty PATH", () => {
		expect(findCliInstalls("neon", scratch())).toEqual([]);
	});
});

describe("formatDuplicateInstallNotice", () => {
	const brew = {
		method: "homebrew",
		path: "/opt/homebrew/bin/neon",
	} as const;
	const npm = {
		method: "npm",
		path: "/Users/user/.nvm/versions/node/v24.18.0/bin/neon",
	} as const;

	it("stays quiet for one install", () => {
		expect(
			formatDuplicateInstallNotice({
				installs: [npm],
				otherNeonctl: false,
			}),
		).toBeUndefined();
	});

	it("recommends removing Homebrew when it shadows npm", () => {
		expect(
			formatDuplicateInstallNotice({
				installs: [brew, npm],
				otherNeonctl: false,
			}),
		).toBe(
			[
				"Multiple Neon CLI installs found on PATH:",
				"  /opt/homebrew/bin/neon (Homebrew, first on PATH)",
				"  /Users/user/.nvm/versions/node/v24.18.0/bin/neon (npm)",
				"Remove the Homebrew install to use npm:",
				"  brew uninstall neonctl",
				"This also removes the `neonctl` command; run `neon` instead.",
				"Then open a new shell.",
			].join("\n"),
		);
	});

	it("recommends removing Homebrew when npm comes first", () => {
		expect(
			formatDuplicateInstallNotice({
				installs: [npm, brew],
				otherNeonctl: false,
			}),
		).toBe(
			[
				"Multiple Neon CLI installs found on PATH:",
				"  /Users/user/.nvm/versions/node/v24.18.0/bin/neon (npm, first on PATH)",
				"  /opt/homebrew/bin/neon (Homebrew)",
				"Remove the Homebrew install to use npm:",
				"  brew uninstall neonctl",
				"This also removes the `neonctl` command; run `neon` instead.",
				"Then open a new shell.",
			].join("\n"),
		);
	});

	it("omits the neonctl note when another install provides neonctl", () => {
		expect(
			formatDuplicateInstallNotice({
				installs: [
					brew,
					{ method: undefined, path: "/usr/local/bin/neon" },
				],
				otherNeonctl: true,
			}),
		).toBe(
			[
				"Multiple Neon CLI installs found on PATH:",
				"  /opt/homebrew/bin/neon (Homebrew, first on PATH)",
				"  /usr/local/bin/neon",
				"Remove the Homebrew install:",
				"  brew uninstall neonctl",
				"Then open a new shell.",
			].join("\n"),
		);
	});

	it("asks to keep one install when Homebrew is not involved", () => {
		expect(
			formatDuplicateInstallNotice({
				installs: [
					npm,
					{ method: "bun", path: "/Users/user/.bun/bin/neon" },
				],
				otherNeonctl: false,
			}),
		).toBe(
			[
				"Multiple Neon CLI installs found on PATH:",
				"  /Users/user/.nvm/versions/node/v24.18.0/bin/neon (npm, first on PATH)",
				"  /Users/user/.bun/bin/neon (Bun)",
				"Keep one: uninstall the others or reorder PATH.",
			].join("\n"),
		);
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
