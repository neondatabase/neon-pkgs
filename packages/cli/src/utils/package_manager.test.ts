import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	detectProjectPackageManager,
	formatInstallCommand,
	globalInstallArgs,
	inferPackageManager,
	resolveInvokingPackageManager,
	resolvePackageManager,
} from "./package_manager.js";

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

	it("treats a leftover package-lock.json next to a pnpm one as pnpm", () => {
		writeFileSync(join(project, "pnpm-lock.yaml"), "");
		writeFileSync(join(project, "package-lock.json"), "");

		expect(detectProjectPackageManager(project)).toBe("pnpm");
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
		["bun", "bun add -d prisma"],
	] as const)("adds a dev dependency with %s", (pm, expected) => {
		expect(formatInstallCommand(pm, ["prisma"], { dev: true })).toBe(
			expected,
		);
	});

	it("ignores the dev flag when installing the whole manifest", () => {
		expect(formatInstallCommand("pnpm", [], { dev: true })).toBe(
			"pnpm install",
		);
	});
});

describe("globalInstallArgs", () => {
	it.each([
		["npm", "npm install -g neonctl"],
		["pnpm", "pnpm add -g neonctl"],
		["bun", "bun add -g neonctl"],
	] as const)("installs globally with %s", (pm, expected) => {
		const { command, args } = globalInstallArgs(pm, "neonctl");
		expect(`${command} ${args.join(" ")}`).toBe(expected);
	});

	describe("yarn depends on the major, which only yarn itself can report", () => {
		const originalPath = process.env.PATH;
		let bin: string;

		/** A real `yarn` on PATH that reports `version`, so no mock is needed. */
		const stubYarn = (version: string) => {
			const script = join(bin, "yarn");
			writeFileSync(script, `#!/bin/sh\necho "${version}"\n`, {
				mode: 0o755,
			});
		};

		beforeEach(() => {
			bin = mkdtempSync(join(tmpdir(), "neonctl-pm-yarn-"));
			process.env.PATH = bin;
		});

		afterEach(() => {
			process.env.PATH = originalPath;
			rmSync(bin, { recursive: true, force: true });
		});

		it("uses `yarn global add` on Classic", () => {
			stubYarn("1.22.22");
			const { command, args } = globalInstallArgs("yarn", "neonctl");
			expect(`${command} ${args.join(" ")}`).toBe(
				"yarn global add neonctl",
			);
		});

		it.each([
			"2.4.3",
			"4.1.0",
		])("falls back to npm on Berry %s, which has no global install", (version) => {
			stubYarn(version);
			const { command, args } = globalInstallArgs("yarn", "neonctl");
			expect(`${command} ${args.join(" ")}`).toBe(
				"npm install -g neonctl",
			);
		});

		it("falls back to npm when yarn cannot be run at all", () => {
			const { command, args } = globalInstallArgs("yarn", "neonctl");
			expect(`${command} ${args.join(" ")}`).toBe(
				"npm install -g neonctl",
			);
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
