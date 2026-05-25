import { afterEach, describe, expect, test } from "vitest";
import {
	buildPlatformInstallCommand,
	ensurePlatformPackageInstalled,
	findPackageInstallTarget,
	formatManualInstallHint,
	isPlatformPackageInstalled,
	PLATFORM_PACKAGE_NAME,
} from "./package-manager.js";
import { makeTempRepo } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

function setup(files: Record<string, string | null>) {
	const repo = makeTempRepo(files);
	cleanups.push(repo.cleanup);
	return repo.root;
}

describe("findPackageInstallTarget", () => {
	test("detects pnpm from a workspace root lockfile", () => {
		const root = setup({
			"package.json": JSON.stringify({ name: "workspace" }),
			"pnpm-lock.yaml": "",
			"apps/web/package.json": JSON.stringify({ name: "web" }),
		});
		const target = findPackageInstallTarget({
			cwd: `${root}/apps/web`,
			stopAt: root,
		});
		expect(target).toEqual({ dir: root, packageManager: "pnpm" });
	});

	test("uses the nearest package.json when no lockfile exists", () => {
		const root = setup({
			"package.json": JSON.stringify({ name: "workspace" }),
			"apps/web/package.json": JSON.stringify({
				name: "web",
				packageManager: "pnpm@10.0.0",
			}),
			"apps/web/src/index.ts": "// hi",
		});
		const target = findPackageInstallTarget({
			cwd: `${root}/apps/web/src`,
			stopAt: root,
		});
		expect(target).toEqual({
			dir: `${root}/apps/web`,
			packageManager: "pnpm",
		});
	});

	test("detects yarn and npm from lockfiles", () => {
		const yarnRoot = setup({
			"package.json": "{}",
			"yarn.lock": "",
		});
		expect(
			findPackageInstallTarget({ cwd: yarnRoot, stopAt: yarnRoot }),
		).toEqual({ dir: yarnRoot, packageManager: "yarn" });

		const npmRoot = setup({
			"package.json": "{}",
			"package-lock.json": "{}",
		});
		expect(
			findPackageInstallTarget({ cwd: npmRoot, stopAt: npmRoot }),
		).toEqual({ dir: npmRoot, packageManager: "npm" });
	});

	test("falls back to nearest package.json and its packageManager field", () => {
		const root = setup({
			"package.json": JSON.stringify({
				name: "app",
				packageManager: "bun@1.2.3",
			}),
		});
		const target = findPackageInstallTarget({ cwd: root, stopAt: root });
		expect(target).toEqual({ dir: root, packageManager: "bun" });
	});

	test("defaults to npm when only package.json exists", () => {
		const root = setup({
			"package.json": JSON.stringify({ name: "app" }),
		});
		const target = findPackageInstallTarget({ cwd: root, stopAt: root });
		expect(target).toEqual({ dir: root, packageManager: "npm" });
	});

	test("returns null when no package.json is found", () => {
		const root = setup({
			"src/index.ts": "// hi",
		});
		const target = findPackageInstallTarget({ cwd: root, stopAt: root });
		expect(target).toBeNull();
	});
});

describe("isPlatformPackageInstalled", () => {
	test("returns true when dependency is present", () => {
		const root = setup({
			"package.json": JSON.stringify({
				dependencies: { [PLATFORM_PACKAGE_NAME]: "^0.1.0" },
			}),
		});
		expect(isPlatformPackageInstalled(root)).toBe(true);
	});

	test("returns true when devDependency is present", () => {
		const root = setup({
			"package.json": JSON.stringify({
				devDependencies: { [PLATFORM_PACKAGE_NAME]: "^0.1.0" },
			}),
		});
		expect(isPlatformPackageInstalled(root)).toBe(true);
	});

	test("returns false when dependency is absent", () => {
		const root = setup({
			"package.json": JSON.stringify({ dependencies: {} }),
		});
		expect(isPlatformPackageInstalled(root)).toBe(false);
	});
});

describe("buildPlatformInstallCommand", () => {
	test("builds npm install args", () => {
		expect(buildPlatformInstallCommand("npm")).toEqual({
			command: "npm",
			args: [
				"install",
				PLATFORM_PACKAGE_NAME,
				"--no-fund",
				"--no-audit",
				"--loglevel=error",
			],
		});
	});

	test("formats manual install hints", () => {
		expect(formatManualInstallHint("pnpm")).toBe(
			`pnpm add ${PLATFORM_PACKAGE_NAME}`,
		);
	});
});

describe("ensurePlatformPackageInstalled", () => {
	test("skips install when dependency is already listed", async () => {
		const root = setup({
			"package.json": JSON.stringify({
				dependencies: { [PLATFORM_PACKAGE_NAME]: "^0.1.0" },
			}),
		});
		const result = await ensurePlatformPackageInstalled({
			cwd: root,
			stopAt: root,
		});
		expect(result).toMatchObject({
			installed: false,
			skipped: true,
			packageRoot: root,
		});
	});

	test("runs install when dependency is missing", async () => {
		const root = setup({
			"package.json": JSON.stringify({ name: "app" }),
			"pnpm-lock.yaml": "",
		});
		const calls: Array<{ command: string; args: string[]; cwd: string }> =
			[];
		const result = await ensurePlatformPackageInstalled(
			{ cwd: root, stopAt: root },
			{
				runInstall: async (command, args, options) => {
					calls.push({ command, args, cwd: options.cwd });
					return 0;
				},
			},
		);
		expect(result.installed).toBe(true);
		expect(calls).toEqual([
			{
				command: "pnpm",
				args: ["add", PLATFORM_PACKAGE_NAME, "--loglevel=error"],
				cwd: root,
			},
		]);
	});

	test("returns failure details when install command exits non-zero", async () => {
		const root = setup({
			"package.json": JSON.stringify({ name: "app" }),
		});
		const result = await ensurePlatformPackageInstalled(
			{ cwd: root, stopAt: root },
			{ runInstall: async () => 1 },
		);
		expect(result).toMatchObject({
			installed: false,
			skipped: false,
			packageRoot: root,
			packageManager: "npm",
		});
		expect(result.message).toContain("Failed to install");
		expect(result.message).toContain("npm install @neondatabase/platform");
	});
});
