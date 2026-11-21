import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	commandEnv,
	detectProjectPackageManager,
	formatExecCommand,
	formatInstallCommand,
	globalInstallCommand,
	inferPackageManager,
	installFailureDetail,
	missingNpxMessage,
	type PackageManager,
	resolveInvokingPackageManager,
	resolvePackageManager,
	runCommandWithDetail,
} from "./package_manager.js";

describe("installFailureDetail", () => {
	it("prefers the spawn error code", () => {
		expect(
			installFailureDetail({
				spawnErrorCode: "spawn ENOENT",
				exitCode: null,
				output: "npm error code ERESOLVE",
			}),
		).toBe("spawn ENOENT");
	});

	it("reads npm, pnpm, and yarn error codes from stderr", () => {
		const detail = (output: string) =>
			installFailureDetail({ exitCode: 1, output });
		expect(
			detail(
				"npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve",
			),
		).toBe("ERESOLVE");
		expect(detail("npm ERR! code E404\nnpm ERR! 404 Not Found")).toBe(
			"E404",
		);
		expect(
			detail(
				"ERR_PNPM_ADDING_TO_ROOT  Running this command will add the dependency to the workspace root",
			),
		).toBe("ERR_PNPM_ADDING_TO_ROOT");
	});

	it("reports yarn failures by exit code, since its records do not mark the failing one", () => {
		expect(
			installFailureDetail({
				exitCode: 1,
				output: "➤ YN0007: │ app@workspace:. must be built because it never has been before\n➤ YN0009: │ app@workspace:. couldn't be built successfully (exit code 1)",
			}),
		).toBe("exit code 1");
	});

	it("reads a code from colored output", () => {
		expect(
			installFailureDetail({
				exitCode: 1,
				output: "\u001b[31mnpm\u001b[39m \u001b[31merror\u001b[39m \u001b[94mcode\u001b[39m EUNSUPPORTEDPROTOCOL",
			}),
		).toBe("EUNSUPPORTEDPROTOCOL");
	});

	it("reports only known codes read from the start of the package manager's error line", () => {
		const detail = (output: string) =>
			installFailureDetail({ exitCode: 1, output });
		expect(
			detail(
				"npm error code 1\nnpm error path /home/someone/ERR_PNPM_CUSTOMER_ACME/app",
			),
		).toBe("exit code 1");
		expect(detail("npm error code ECUSTOMERNAME")).toBe("exit code 1");
		expect(detail("> postinstall\nprinting npm error code ERESOLVE")).toBe(
			"exit code 1",
		);
		expect(detail("npm error code 1\nnpm error code ERESOLVE")).toBe(
			"ERESOLVE",
		);
	});

	it("ignores an npm code that is not a bounded token", () => {
		expect(
			installFailureDetail({
				exitCode: 1,
				output: "npm error code /Users/someone/secret-path",
			}),
		).toBe("exit code 1");
	});

	it("falls back to the exit code and never returns free-form output", () => {
		expect(
			installFailureDetail({
				exitCode: 2,
				output: "error: /Users/someone/app/package.json is broken",
			}),
		).toBe("exit code 2");
		expect(installFailureDetail({ exitCode: null, output: "" })).toBe(
			"killed",
		);
	});
});

describe("runCommandWithDetail", () => {
	const streams = [process.stdout, process.stderr];
	const isTTY = streams.map((stream) => stream.isTTY);
	beforeEach(() => {
		for (const stream of streams) {
			Object.defineProperty(stream, "isTTY", {
				value: false,
				configurable: true,
			});
		}
	});
	afterEach(() => {
		streams.forEach((stream, index) => {
			Object.defineProperty(stream, "isTTY", {
				value: isTTY[index],
				configurable: true,
			});
		});
		vi.restoreAllMocks();
	});

	it("reads a code the package manager prints on stdout, as pnpm does", async () => {
		const write = vi.spyOn(process.stdout, "write");
		const result = await runCommandWithDetail(
			process.execPath,
			[
				"-e",
				'process.stdout.write(" ERR_PNPM_NO_OFFLINE_META  Failed to resolve\\n"); process.exit(1)',
			],
			tmpdir(),
		);
		expect(result).toEqual({
			ok: false,
			detail: "ERR_PNPM_NO_OFFLINE_META",
		});
		expect(
			write.mock.calls.some((call) =>
				String(call[0]).includes("ERR_PNPM_NO_OFFLINE_META"),
			),
		).toBe(true);
	});

	it("passes the child's stderr through and reports its error code", async () => {
		const write = vi.spyOn(process.stderr, "write");
		const result = await runCommandWithDetail(
			process.execPath,
			[
				"-e",
				'process.stderr.write("npm error code ERESOLVE\\n"); process.exit(1)',
			],
			tmpdir(),
		);
		expect(result).toEqual({ ok: false, detail: "ERESOLVE" });
		expect(
			write.mock.calls.some((call) =>
				String(call[0]).includes("npm error code ERESOLVE"),
			),
		).toBe(true);
	});

	it("delivers all of a large output to a slow reader, with bounded buffering, before resolving", async () => {
		const bytes = 1024 * 1024;
		const built = new URL(
			"../../dist/utils/package_manager.js",
			import.meta.url,
		).href;
		const runner = `
import { runCommandWithDetail } from ${JSON.stringify(built)};
let queued = 0;
const sample = setInterval(() => { queued = Math.max(queued, process.stdout.writableLength); }, 5);
const result = await runCommandWithDetail(process.execPath, ["-e", "process.stdout.write('x'.repeat(${bytes})); process.exitCode = 1"], process.cwd());
clearInterval(sample);
process.stderr.write(JSON.stringify({ ...result, queued }));
process.exit(1);
`;
		const received = await new Promise<{ stdout: number; stderr: string }>(
			(resolveRun, reject) => {
				const child = spawn(
					process.execPath,
					["--input-type=module", "-e", runner],
					{ stdio: ["ignore", "pipe", "pipe"] },
				);
				let stdout = 0;
				let stderr = "";
				child.stdout.pause();
				setTimeout(() => {
					child.stdout.on("data", (chunk: Buffer) => {
						stdout += chunk.length;
					});
					child.stdout.resume();
				}, 300);
				child.stderr.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				child.on("error", reject);
				child.on("close", () => resolveRun({ stdout, stderr }));
			},
		);
		expect(received.stdout).toBe(bytes);
		const result = JSON.parse(
			received.stderr.slice(received.stderr.indexOf("{")),
		);
		expect(result).toMatchObject({ ok: false, detail: "exit code 1" });
		// The child is paused while our pipe is full, so our queue stays far below its output.
		expect(result.queued).toBeLessThan(bytes / 2);
	});

	it("reports a missing command by its spawn error code", async () => {
		expect(
			await runCommandWithDetail(
				"neon-definitely-not-a-package-manager",
				["install"],
				tmpdir(),
			),
		).toEqual({ ok: false, detail: "spawn ENOENT" });
	});

	it("succeeds without a detail", async () => {
		expect(
			await runCommandWithDetail(process.execPath, ["-e", ""], tmpdir()),
		).toEqual({ ok: true });
	});
});

describe("detectProjectPackageManager", () => {
	let project: string;

	beforeEach(() => {
		project = mkdtempSync(join(tmpdir(), "neonctl-pm-detect-"));
		// Marks the temp dir as a repo root so the walk stops here instead of
		// climbing into $TMPDIR and beyond, where another process's stray
		// lockfile would decide these assertions.
		mkdirSync(join(project, ".git"));
	});

	afterEach(() => {
		rmSync(project, { recursive: true, force: true });
	});

	it.each([
		["pnpm-lock.yaml", "pnpm"],
		["yarn.lock", "yarn"],
		["bun.lock", "bun"],
		["bun.lockb", "bun"],
		["package-lock.json", "npm"],
		["npm-shrinkwrap.json", "npm"],
	])("reads %s as %s", (lockfile, expected) => {
		writeFileSync(join(project, lockfile), "");
		expect(detectProjectPackageManager(project)).toBe(expected);
	});

	it("finds the root lockfile from a nested package directory", () => {
		// The reason the walk exists. The root is also the boundary, so this only
		// works because each directory's lockfiles are checked before its `.git`.
		writeFileSync(join(project, "pnpm-lock.yaml"), "");
		const nested = join(project, "packages", "app");
		mkdirSync(nested, { recursive: true });

		expect(detectProjectPackageManager(nested)).toBe("pnpm");
	});

	it("prefers a package's own lockfile over the one at the root", () => {
		writeFileSync(join(project, "pnpm-lock.yaml"), "");
		const nested = join(project, "vendored");
		mkdirSync(nested);
		writeFileSync(join(nested, "yarn.lock"), "");

		expect(detectProjectPackageManager(nested)).toBe("yarn");
	});

	describe("lockfiles from several package managers", () => {
		const originalPath = process.env.PATH;
		let bin: string;

		const install = (...names: PackageManager[]) => {
			for (const name of names) {
				writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", {
					mode: 0o755,
				});
			}
		};

		beforeEach(() => {
			bin = mkdtempSync(join(tmpdir(), "neonctl-pm-detect-bin-"));
			process.env.PATH = bin;
		});

		afterEach(() => {
			process.env.PATH = originalPath;
			rmSync(bin, { recursive: true, force: true });
		});

		it("treats a leftover package-lock.json next to a pnpm one as pnpm", () => {
			install("pnpm", "npm");
			writeFileSync(join(project, "pnpm-lock.yaml"), "");
			writeFileSync(join(project, "package-lock.json"), "");

			expect(detectProjectPackageManager(project)).toBe("pnpm");
		});

		it("picks npm for bun.lockb beside package-lock.json when bun is not installed", () => {
			install("npm");
			writeFileSync(join(project, "bun.lockb"), "");
			writeFileSync(join(project, "package-lock.json"), "");

			expect(detectProjectPackageManager(project)).toBe("npm");
		});

		it("picks the installed manager from the repo root of a nested package", () => {
			install("npm");
			writeFileSync(join(project, "pnpm-lock.yaml"), "");
			writeFileSync(join(project, "package-lock.json"), "");
			const nested = join(project, "packages", "app");
			mkdirSync(nested, { recursive: true });

			expect(detectProjectPackageManager(nested)).toBe("npm");
		});

		it("keeps the first lockfile's manager when it is installed", () => {
			install("bun", "npm");
			writeFileSync(join(project, "bun.lockb"), "");
			writeFileSync(join(project, "package-lock.json"), "");

			expect(detectProjectPackageManager(project)).toBe("bun");
		});

		it("keeps the first lockfile's manager when none is installed", () => {
			writeFileSync(join(project, "bun.lockb"), "");
			writeFileSync(join(project, "package-lock.json"), "");

			expect(detectProjectPackageManager(project)).toBe("bun");
		});

		it("keeps the manager package.json pins even when it is not installed", () => {
			install("npm");
			writeFileSync(
				join(project, "package.json"),
				JSON.stringify({ packageManager: "pnpm@10.12.1" }),
			);
			writeFileSync(join(project, "pnpm-lock.yaml"), "");
			writeFileSync(join(project, "package-lock.json"), "");

			expect(detectProjectPackageManager(project)).toBe("pnpm");
		});

		it("follows the packageManager pin over an installed first lockfile", () => {
			install("bun", "npm");
			writeFileSync(
				join(project, "package.json"),
				JSON.stringify({ packageManager: "npm@10.9.2" }),
			);
			writeFileSync(join(project, "bun.lockb"), "");
			writeFileSync(join(project, "package-lock.json"), "");

			expect(detectProjectPackageManager(project)).toBe("npm");
		});

		it("keeps pnpm at a pnpm workspace root, whose workspace: dependencies npm cannot install", () => {
			install("npm");
			writeFileSync(
				join(project, "pnpm-workspace.yaml"),
				"packages:\n  - apps/*\n",
			);
			writeFileSync(join(project, "pnpm-lock.yaml"), "");
			writeFileSync(join(project, "package-lock.json"), "");

			expect(detectProjectPackageManager(project)).toBe("pnpm");
		});

		it("keeps pnpm when node_modules is pnpm's layout, which npm cannot install into", () => {
			install("npm");
			mkdirSync(join(project, "node_modules", ".pnpm"), {
				recursive: true,
			});
			writeFileSync(join(project, "pnpm-lock.yaml"), "");
			writeFileSync(join(project, "package-lock.json"), "");

			expect(detectProjectPackageManager(project)).toBe("pnpm");
		});

		it("never switches a project with one manager's lockfiles", () => {
			install("npm");
			writeFileSync(join(project, "bun.lock"), "");
			writeFileSync(join(project, "bun.lockb"), "");

			expect(detectProjectPackageManager(project)).toBe("bun");
		});
	});

	it("does not look outside the repo for a lockfile", () => {
		const inner = join(project, "vendored");
		mkdirSync(join(inner, ".git"), { recursive: true });
		writeFileSync(join(project, "pnpm-lock.yaml"), "");

		expect(detectProjectPackageManager(inner)).toBeUndefined();
	});

	it("reports no lockfile for a project without one", () => {
		expect(detectProjectPackageManager(project)).toBeUndefined();
	});
});

describe("detectProjectPackageManager outside a repository", () => {
	// What `bootstrap` scaffolds into: the directory has no `.git` yet, because
	// `git init` is a later step in the flow.
	let outside: string;

	beforeEach(() => {
		outside = mkdtempSync(join(tmpdir(), "neonctl-pm-loose-"));
	});

	afterEach(() => {
		rmSync(outside, { recursive: true, force: true });
	});

	it("reads the directory's own lockfile", () => {
		const target = join(outside, "new-app");
		mkdirSync(target);
		writeFileSync(join(target, "bun.lock"), "");

		expect(detectProjectPackageManager(target)).toBe("bun");
	});

	it("ignores an ancestor's lockfile when no repository contains it", () => {
		// The bug this guards: a scaffold under a directory that merely happens to
		// have a lockfile above it would install with that manager, on the strength
		// of a lockfile belonging to no project of ours.
		writeFileSync(join(outside, "package-lock.json"), "");
		const target = join(outside, "new-app");
		mkdirSync(target);

		expect(detectProjectPackageManager(target)).toBeUndefined();
	});

	it("still reads an ancestor's lockfile once a repository contains both", () => {
		mkdirSync(join(outside, ".git"));
		writeFileSync(join(outside, "pnpm-lock.yaml"), "");
		const target = join(outside, "packages", "new-app");
		mkdirSync(target, { recursive: true });

		expect(detectProjectPackageManager(target)).toBe("pnpm");
	});

	it("treats a directory that does not exist yet as its lexical path", () => {
		// bootstrap resolves a target before creating it, so this is normal.
		mkdirSync(join(outside, ".git"));
		writeFileSync(join(outside, "bun.lock"), "");

		expect(
			detectProjectPackageManager(join(outside, "not-created-yet")),
		).toBe("bun");
	});

	it("refuses to guess when the path is broken rather than missing", () => {
		// A path whose parent component is a file, not a directory: ENOTDIR. The
		// old catch-all would silently fall back to a lexical walk from here.
		writeFileSync(join(outside, "a-file"), "");

		expect(() =>
			detectProjectPackageManager(
				join(outside, "a-file", "under-a-file"),
			),
		).toThrow(/Could not resolve/);
	});

	it("follows a symlink into the repository it really points at", () => {
		// `dirname` is lexical, so walking the link's own path leaves the repo
		// immediately and never reaches the root lockfile.
		mkdirSync(join(outside, "repo", ".git"), { recursive: true });
		writeFileSync(join(outside, "repo", "yarn.lock"), "");
		const real = join(outside, "repo", "packages", "app");
		mkdirSync(real, { recursive: true });

		const link = join(outside, "link-to-app");
		symlinkSync(real, link);

		expect(detectProjectPackageManager(link)).toBe("yarn");
	});
});

describe("resolvePackageManager", () => {
	let project: string;
	const originalUserAgent = process.env.npm_config_user_agent;

	beforeEach(() => {
		project = mkdtempSync(join(tmpdir(), "neonctl-pm-resolve-"));
		mkdirSync(join(project, ".git"));
	});

	afterEach(() => {
		rmSync(project, { recursive: true, force: true });
		if (originalUserAgent === undefined) {
			delete process.env.npm_config_user_agent;
		} else {
			process.env.npm_config_user_agent = originalUserAgent;
		}
	});

	it("prefers the project over the package manager that invoked us", () => {
		// The bug this guards: `npx neon link` in a pnpm repo ran `npm install`,
		// and npm's arborist crashed on pnpm's symlinked node_modules.
		process.env.npm_config_user_agent =
			"npm/11.11.0 node/v24.14.1 darwin x64";
		writeFileSync(join(project, "pnpm-lock.yaml"), "");

		expect(resolvePackageManager(project)).toBe("pnpm");
	});

	it("falls back to the invoking package manager when the project has no lockfile", () => {
		process.env.npm_config_user_agent =
			"yarn/4.1.0 npm/? node/v24.14.1 darwin x64";

		expect(resolvePackageManager(project)).toBe("yarn");
	});
});

describe("resolveInvokingPackageManager", () => {
	const originalUserAgent = process.env.npm_config_user_agent;
	const originalPath = process.env.PATH;
	let emptyBin: string;

	beforeEach(() => {
		// An empty PATH makes `installedPackageManagers()` empty whatever this
		// machine has, so the final `?? "npm"` is what these assertions see.
		emptyBin = mkdtempSync(join(tmpdir(), "neonctl-pm-path-"));
		process.env.PATH = emptyBin;
	});

	afterEach(() => {
		rmSync(emptyBin, { recursive: true, force: true });
		process.env.PATH = originalPath;
		if (originalUserAgent === undefined) {
			delete process.env.npm_config_user_agent;
		} else {
			process.env.npm_config_user_agent = originalUserAgent;
		}
	});

	it("falls back to npm when nothing is inferable", () => {
		delete process.env.npm_config_user_agent;
		expect(resolveInvokingPackageManager()).toBe("npm");
	});

	it("reads the invoking package manager from npm_config_user_agent", () => {
		process.env.npm_config_user_agent =
			"bun/1.2.0 npm/? node/v24.14.1 darwin arm64";
		expect(resolveInvokingPackageManager()).toBe("bun");
	});
});

describe("formatInstallCommand", () => {
	it.each([
		"npm",
		"pnpm",
		"yarn",
		"bun",
	] as const)("installs the whole manifest with `%s install`", (pm) => {
		expect(formatInstallCommand(pm)).toBe(`${pm} install`);
	});

	it.each([
		["npm", "npm install @neon/config @neon/env"],
		["pnpm", "pnpm add @neon/config @neon/env"],
		["yarn", "yarn add @neon/config @neon/env"],
		["bun", "bun add @neon/config @neon/env"],
	] as const)("adds packages with %s", (pm, expected) => {
		expect(formatInstallCommand(pm, ["@neon/config", "@neon/env"])).toBe(
			expected,
		);
	});

	it.each([
		["npm", "npm install -D prisma"],
		["pnpm", "pnpm add -D prisma"],
		["yarn", "yarn add -D prisma"],
		// bun is the one that rejects -D.
		["bun", "bun add -D prisma"],
	] as const)("adds a dev dependency with %s", (pm, expected) => {
		expect(formatInstallCommand(pm, ["prisma"], { dev: true })).toBe(
			expected,
		);
	});

	it.each([
		["npm", "npm install -E mailer-sdk@1.2.3"],
		["pnpm", "pnpm add -E mailer-sdk@1.2.3"],
		["yarn", "yarn add -E mailer-sdk@1.2.3"],
		["bun", "bun add -E mailer-sdk@1.2.3"],
	] as const)("saves an exact version with %s", (pm, expected) => {
		expect(
			formatInstallCommand(pm, ["mailer-sdk@1.2.3"], { exact: true }),
		).toBe(expected);
	});

	it("ignores the dev flag when installing the whole manifest", () => {
		expect(formatInstallCommand("pnpm", [], { dev: true })).toBe(
			"pnpm install",
		);
	});
});

describe("adding to a workspace root", () => {
	const originalPath = process.env.PATH;
	let root: string;
	let bin: string;

	const add = (pm: PackageManager, dir = root) =>
		formatInstallCommand(pm, ["@neon/config", "@neon/env"], { dir });

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "neonctl-pm-workspace-"));
		bin = mkdtempSync(join(tmpdir(), "neonctl-pm-workspace-bin-"));
		process.env.PATH = bin;
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
		rmSync(bin, { recursive: true, force: true });
	});

	it("passes -w to pnpm at a pnpm workspace root", () => {
		writeFileSync(
			join(root, "pnpm-workspace.yaml"),
			"packages:\n  - apps/*\n",
		);
		expect(add("pnpm")).toBe("pnpm add -w @neon/config @neon/env");
		expect(
			formatInstallCommand("pnpm", ["mailer-sdk@1.2.3"], {
				exact: true,
				dir: root,
			}),
		).toBe("pnpm add -w -E mailer-sdk@1.2.3");
	});

	it("leaves a pnpm workspace package, a plain project, and whole-manifest installs alone", () => {
		writeFileSync(
			join(root, "pnpm-workspace.yaml"),
			"packages:\n  - apps/*\n",
		);
		const app = join(root, "apps", "web");
		mkdirSync(app, { recursive: true });
		expect(add("pnpm", app)).toBe("pnpm add @neon/config @neon/env");
		expect(formatInstallCommand("pnpm", [], { dir: root })).toBe(
			"pnpm install",
		);
		rmSync(join(root, "pnpm-workspace.yaml"));
		expect(add("pnpm")).toBe("pnpm add @neon/config @neon/env");
	});

	const yarnRoot = (manifest: Record<string, unknown> = {}) =>
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				private: true,
				workspaces: ["apps/*"],
				...manifest,
			}),
		);
	const CLASSIC_LOCK =
		"# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n";
	const BERRY_LOCK = "__metadata:\n  version: 8\n  cacheKey: 10c0\n";

	it("passes -W to Yarn Classic at a yarn workspace root", () => {
		yarnRoot();
		writeFileSync(join(root, "yarn.lock"), CLASSIC_LOCK);
		expect(add("yarn")).toBe("yarn add -W @neon/config @neon/env");
		rmSync(join(root, "yarn.lock"));
		yarnRoot({ packageManager: "yarn@1.22.22" });
		expect(add("yarn")).toBe("yarn add -W @neon/config @neon/env");
	});

	it("adds no flag for Yarn Berry, or outside a yarn workspace root", () => {
		yarnRoot();
		writeFileSync(join(root, "yarn.lock"), BERRY_LOCK);
		expect(add("yarn")).toBe("yarn add @neon/config @neon/env");
		yarnRoot({ packageManager: "yarn@4.1.0" });
		writeFileSync(join(root, "yarn.lock"), CLASSIC_LOCK);
		expect(add("yarn")).toBe("yarn add @neon/config @neon/env");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ private: true }),
		);
		expect(add("yarn")).toBe("yarn add @neon/config @neon/env");
	});

	it("never runs yarn to word the command", () => {
		const ran = join(root, "yarn-ran");
		writeFileSync(
			join(bin, "yarn"),
			`#!/bin/sh\n: > "${ran}"\necho 1.22.22\n`,
			{
				mode: 0o755,
			},
		);
		yarnRoot();
		writeFileSync(join(root, "yarn.lock"), CLASSIC_LOCK);
		expect(add("yarn")).toBe("yarn add -W @neon/config @neon/env");
		expect(existsSync(ran)).toBe(false);
	});

	it.each([
		["npm", "npm install @neon/config @neon/env"],
		["bun", "bun add @neon/config @neon/env"],
	] as const)("adds no flag for %s, which adds to a root as asked", (pm, expected) => {
		writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ private: true, workspaces: ["apps/*"] }),
		);
		expect(add(pm)).toBe(expected);
	});
});

describe("missingNpxMessage", () => {
	const originalPath = process.env.PATH;
	const originalUserAgent = process.env.npm_config_user_agent;
	let bin: string;

	beforeEach(() => {
		bin = mkdtempSync(join(tmpdir(), "neonctl-pm-npx-"));
		process.env.PATH = bin;
		delete process.env.npm_config_user_agent;
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		if (originalUserAgent === undefined) {
			delete process.env.npm_config_user_agent;
		} else {
			process.env.npm_config_user_agent = originalUserAgent;
		}
		rmSync(bin, { recursive: true, force: true });
	});

	it("names the global install that brings npx back", () => {
		writeFileSync(join(bin, "pnpm"), "#!/bin/sh\nexit 0\n", {
			mode: 0o755,
		});
		expect(missingNpxMessage("neon plugins", "plugins CLI")).toBe(
			"neon plugins needs npx (Node.js) to run the plugins CLI, but npx is not on PATH. Install npm, which provides npx, with `pnpm add -g npm`, then retry.",
		);
	});

	it("points at the Node.js installer when nothing can install npm", () => {
		expect(missingNpxMessage("neon skills", "skills CLI")).toBe(
			"neon skills needs npx (Node.js) to run the skills CLI, but npx is not on PATH. Install npm, which provides npx (it comes with Node.js from nodejs.org), then retry.",
		);
	});

	it("never runs yarn, even when yarn invoked the CLI", () => {
		const ran = join(bin, "yarn-ran");
		writeFileSync(
			join(bin, "yarn"),
			`#!/bin/sh\n: > "${ran}"\necho 1.22.22\n`,
			{
				mode: 0o755,
			},
		);
		process.env.npm_config_user_agent = "yarn/1.22.22 npm/? node/v24.0.0";
		expect(missingNpxMessage("neon skills", "skills CLI")).toBe(
			"neon skills needs npx (Node.js) to run the skills CLI, but npx is not on PATH. Install npm, which provides npx (it comes with Node.js from nodejs.org), then retry.",
		);
		expect(existsSync(ran)).toBe(false);
	});
});

describe("formatExecCommand", () => {
	it.each([
		["npm", "npx --no drizzle-kit generate"],
		["pnpm", "pnpm exec drizzle-kit generate"],
		["yarn", "yarn run drizzle-kit generate"],
		["bun", "bun run drizzle-kit generate"],
	] as const)("runs a project binary with %s", (pm, expected) => {
		expect(formatExecCommand(pm, "drizzle-kit", ["generate"])).toBe(
			expected,
		);
	});

	it.each([
		"npm",
		"pnpm",
		"yarn",
		"bun",
	] as const)("never emits a form that downloads a missing package (%s)", (pm) => {
		// Bare `npx`/`bunx` and the `dlx` subcommands all fetch. A migration
		// step that silently downloads an unpinned drizzle-kit and runs it
		// against a database is the failure this guards.
		const command = formatExecCommand(pm, "drizzle-kit", ["migrate"]);
		expect(command).not.toMatch(/\bdlx\b/);
		expect(command).not.toMatch(/^bunx\b/);
		expect(command).not.toMatch(/^npx (?!--no\b)/);
	});

	it("takes no arguments", () => {
		expect(formatExecCommand("pnpm", "prisma")).toBe("pnpm exec prisma");
	});
});

describe("globalInstallCommand", () => {
	const formatGlobalInstall = (pm: PackageManager): string | undefined => {
		const install = globalInstallCommand(pm, "neonctl");
		return install && `${install.command} ${install.args.join(" ")}`;
	};

	// Every case pins PATH. Asserting `bun add -g` on a machine that happens to
	// have bun is not a test of anything: CI has no bun, so the unpinned version
	// of this passed here and failed there.
	describe("what is on PATH decides", () => {
		const originalPath = process.env.PATH;
		let bin: string;

		const install = (name: string) =>
			writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", {
				mode: 0o755,
			});

		beforeEach(() => {
			bin = mkdtempSync(join(tmpdir(), "neonctl-pm-global-"));
			process.env.PATH = bin;
		});

		afterEach(() => {
			process.env.PATH = originalPath;
			rmSync(bin, { recursive: true, force: true });
		});

		it.each([
			["npm", "npm install -g neonctl"],
			["pnpm", "pnpm add -g neonctl"],
			["bun", "bun add -g neonctl"],
		] as const)("installs globally with %s", (pm, expected) => {
			install(pm);
			expect(formatGlobalInstall(pm)).toBe(expected);
		});

		it.each([
			"npm",
			"pnpm",
			"bun",
		] as const)("returns nothing for %s when nothing is installed", (pm) => {
			// `resolveInvokingPackageManager` ends in `?? "npm"`, a guess about
			// a machine no one has looked at — so npm needs the same PATH check
			// the yarn fallback gets.
			expect(globalInstallCommand(pm, "neonctl")).toBeUndefined();
		});

		it("borrows an installed manager when the requested one is absent", () => {
			install("pnpm");
			expect(formatGlobalInstall("npm")).toBe("pnpm add -g neonctl");
		});
	});

	describe("yarn depends on the major, which only yarn itself can report", () => {
		const originalPath = process.env.PATH;
		let bin: string;

		/** A real executable on PATH, so none of this needs a mock. */
		const stub = (name: string, output: string) =>
			writeFileSync(join(bin, name), `#!/bin/sh\necho "${output}"\n`, {
				mode: 0o755,
			});

		beforeEach(() => {
			bin = mkdtempSync(join(tmpdir(), "neonctl-pm-yarn-"));
			process.env.PATH = bin;
		});

		afterEach(() => {
			process.env.PATH = originalPath;
			rmSync(bin, { recursive: true, force: true });
		});

		it("uses `yarn global add` on Classic", () => {
			stub("yarn", "1.22.22");
			expect(formatGlobalInstall("yarn")).toBe("yarn global add neonctl");
		});

		it.each([
			"2.4.3",
			"4.1.0",
		])("borrows a global-capable manager on Berry %s", (version) => {
			stub("yarn", version);
			stub("npm", "11.0.0");
			expect(formatGlobalInstall("yarn")).toBe("npm install -g neonctl");
		});

		it("borrows pnpm when Berry is the yarn and npm is not installed", () => {
			// npm ships with Node, but some Linux distributions package it
			// separately, so its presence cannot be assumed.
			stub("yarn", "4.1.0");
			stub("pnpm", "10.0.0");
			expect(formatGlobalInstall("yarn")).toBe("pnpm add -g neonctl");
		});

		it("returns nothing when no manager on the machine can install globally", () => {
			stub("yarn", "4.1.0");
			expect(globalInstallCommand("yarn", "neonctl")).toBeUndefined();
		});

		it("treats an unreadable yarn version as Berry", () => {
			stub("npm", "11.0.0");
			expect(formatGlobalInstall("yarn")).toBe("npm install -g neonctl");
		});
	});
});

describe("inferPackageManager", () => {
	let project: string;
	const originalUserAgent = process.env.npm_config_user_agent;

	beforeEach(() => {
		project = mkdtempSync(join(tmpdir(), "neonctl-pm-infer-"));
		mkdirSync(join(project, ".git"));
	});

	afterEach(() => {
		rmSync(project, { recursive: true, force: true });
		if (originalUserAgent === undefined) {
			delete process.env.npm_config_user_agent;
		} else {
			process.env.npm_config_user_agent = originalUserAgent;
		}
	});

	it("returns undefined rather than guessing, so a caller can prompt", () => {
		delete process.env.npm_config_user_agent;
		expect(inferPackageManager(project)).toBeUndefined();
	});

	it("prefers the project's lockfile over the invocation", () => {
		process.env.npm_config_user_agent =
			"npm/11.11.0 node/v24.14.1 darwin x64";
		writeFileSync(join(project, "bun.lock"), "");
		expect(inferPackageManager(project)).toBe("bun");
	});
});

describe("commandEnv", () => {
	it("strips an inherited NEON_API_KEY from npm and git children", () => {
		expect(
			commandEnv(undefined, { PATH: "/bin", NEON_API_KEY: "napi_env" }),
		).toEqual({ PATH: "/bin" });
	});

	it("strips mixed-case inherited keys", () => {
		expect(
			commandEnv(undefined, { PATH: "/bin", neon_api_key: "napi_mixed" }),
		).toEqual({ PATH: "/bin" });
	});

	it("keeps an explicit overlay key", () => {
		expect(
			commandEnv(
				{ NEON_API_KEY: "napi_flag" },
				{ PATH: "/bin", NEON_API_KEY: "napi_env" },
			),
		).toEqual({ PATH: "/bin", NEON_API_KEY: "napi_flag" });
	});
});
