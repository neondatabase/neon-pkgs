import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	captureShellEnv,
	devEnvContext,
	formatEnvFiles,
	loadDevEnvFiles,
	reportDevCredential,
} from "./dev.js";

/**
 * What `neon dev` loads into process.env before neon.ts is evaluated, so Function env
 * values written as `process.env.X!` resolve from the project's dotenv files.
 */
describe("neon dev's dotenv loading", () => {
	let dir: string;
	const keys = ["DEV_A", "DEV_B", "DEV_C", "DEV_ONLY_DEFAULT", "DEV_SHELL"];
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "neonctl-dev-load-"));
		for (const key of keys) vi.stubEnv(key, undefined);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const key of keys) delete process.env[key];
		rmSync(dir, { recursive: true, force: true });
	});

	const ctx = () => ({ contextFile: join(dir, ".neon") });

	it("loads nothing when the project has no dotenv file", () => {
		loadDevEnvFiles(ctx(), dir);
		expect(process.env.DEV_A).toBeUndefined();
	});

	it("loads .env when it is the only file", () => {
		writeFileSync(join(dir, ".env"), "DEV_A=from-env\n");
		loadDevEnvFiles(ctx(), dir);
		expect(process.env.DEV_A).toBe("from-env");
	});

	it("loads .env, then .env.local, which overrides it", () => {
		writeFileSync(join(dir, ".env"), "DEV_A=1\nDEV_B=2\n");
		writeFileSync(join(dir, ".env.local"), "DEV_A=2\nDEV_C=3\n");
		const loaded = loadDevEnvFiles(ctx(), dir);
		expect(process.env.DEV_A).toBe("2");
		expect(process.env.DEV_B).toBe("2");
		expect(process.env.DEV_C).toBe("3");
		expect(loaded).toEqual([
			{ path: join(dir, ".env"), applied: ["DEV_A", "DEV_B"] },
			{ path: join(dir, ".env.local"), applied: ["DEV_A", "DEV_C"] },
		]);
		expect(formatEnvFiles(loaded, dir)).toBe(
			".env (2 vars) → .env.local (2 vars)",
		);
	});

	it("says when no dotenv file was loaded", () => {
		expect(formatEnvFiles(loadDevEnvFiles(ctx(), dir), dir)).toBe(
			"none (no .env.local or .env)",
		);
	});

	it("names files relative to cwd", () => {
		const sub = join(dir, "apps", "web");
		mkdirSync(sub, { recursive: true });
		writeFileSync(join(dir, ".env.local"), "DEV_A=1\nDEV_B=2\n");
		expect(formatEnvFiles(loadDevEnvFiles(ctx(), sub), sub)).toBe(
			"../../.env.local (2 vars)",
		);
	});

	it("never overrides a variable already set in the shell", () => {
		vi.stubEnv("DEV_SHELL", "from-shell");
		writeFileSync(join(dir, ".env.local"), "DEV_SHELL=from-env-local\n");
		writeFileSync(join(dir, ".env"), "DEV_SHELL=from-env\n");
		loadDevEnvFiles(ctx(), dir);
		expect(process.env.DEV_SHELL).toBe("from-shell");
	});

	it("treats a shell name in different case as set on Windows", () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			vi.stubEnv("Dev_Shell", "from-shell");
			writeFileSync(join(dir, ".env.local"), "DEV_SHELL=from-file\n");
			expect(loadDevEnvFiles(ctx(), dir)).toEqual([
				{ path: join(dir, ".env.local"), applied: [] },
			]);
		} finally {
			if (platform) Object.defineProperty(process, "platform", platform);
			delete process.env.Dev_Shell;
		}
	});

	it("captures PORT through process.env, which Windows looks up case-insensitively", () => {
		const env = process.env;
		const windowsEnv = new Proxy<NodeJS.ProcessEnv>(
			{ Port: "4321" },
			{
				get: (target, key) =>
					typeof key === "string"
						? Object.entries(target).find(
								([name]) =>
									name.toUpperCase() === key.toUpperCase(),
							)?.[1]
						: undefined,
			},
		);
		Object.defineProperty(process, "env", { value: windowsEnv });
		try {
			expect(captureShellEnv().PORT).toBe("4321");
		} finally {
			Object.defineProperty(process, "env", { value: env });
		}
	});

	it("loads only the --env file, and resolves it from cwd", () => {
		writeFileSync(
			join(dir, ".env.local"),
			"DEV_A=from-default\nDEV_ONLY_DEFAULT=x\n",
		);
		writeFileSync(join(dir, "custom.env"), "DEV_A=from-explicit\n");
		loadDevEnvFiles({ ...ctx(), env: "custom.env" }, dir);
		expect(process.env.DEV_A).toBe("from-explicit");
		expect(process.env.DEV_ONLY_DEFAULT).toBeUndefined();
	});

	it("keeps a shell value over the --env file too", () => {
		vi.stubEnv("DEV_SHELL", "from-shell");
		writeFileSync(join(dir, "custom.env"), "DEV_SHELL=from-explicit\n");
		loadDevEnvFiles({ ...ctx(), env: "custom.env" }, dir);
		expect(process.env.DEV_SHELL).toBe("from-shell");
	});

	it("reads defaults beside .neon from a linked subdirectory, but --env from cwd", () => {
		const sub = join(dir, "apps", "web");
		mkdirSync(sub, { recursive: true });
		writeFileSync(join(dir, ".env.local"), "DEV_A=from-project\n");
		writeFileSync(join(sub, ".env.local"), "DEV_A=from-subdir\n");
		writeFileSync(join(sub, "custom.env"), "DEV_B=from-subdir-explicit\n");

		loadDevEnvFiles(ctx(), sub);
		expect(process.env.DEV_A).toBe("from-project");

		delete process.env.DEV_A;
		loadDevEnvFiles({ ...ctx(), env: "custom.env" }, sub);
		expect(process.env.DEV_B).toBe("from-subdir-explicit");
		expect(process.env.DEV_A).toBeUndefined();
	});

	it("fails on a missing --env file instead of running without it", () => {
		expect(() =>
			loadDevEnvFiles({ ...ctx(), env: "nope.env" }, dir),
		).toThrow(/Env file not found: .*nope\.env/);
	});

	it("keeps credential reuse on the file `env pull` writes, unmixed with .env.local", () => {
		vi.stubEnv("AWS_ACCESS_KEY_ID", undefined);
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", undefined);
		writeFileSync(
			join(dir, ".env"),
			"AWS_ACCESS_KEY_ID=current-id\nAWS_SECRET_ACCESS_KEY=current-secret\n",
		);
		writeFileSync(join(dir, ".env.local"), "AWS_SECRET_ACCESS_KEY=stale\n");
		const shell = { ...process.env };

		loadDevEnvFiles(ctx(), dir);
		const { env } = devEnvContext(
			{ apiKey: "k", apiHost: "https://api", projectId: "p", ...ctx() },
			"br-1",
			dir,
			shell,
		);

		expect(process.env.AWS_SECRET_ACCESS_KEY).toBe("stale");
		expect(env.AWS_ACCESS_KEY_ID).toBe("current-id");
		expect(env.AWS_SECRET_ACCESS_KEY).toBe("current-secret");
	});
});

/**
 * What `neon dev` hands the resolver. Two properties matter and neither is visible from the
 * resolver's own tests: that dev asks for the AI Gateway (so local matches the deployed
 * runtime), and that it reads the local dotenv file (so the branch credential is reused
 * instead of re-minted on every start).
 */
describe("neon dev's resolver context", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "neonctl-dev-ctx-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	const props = { apiKey: "k", apiHost: "https://api", projectId: "p" };

	/** Capture what a call wrote to stderr, which is where the CLI's logger goes. */
	const captureStderr = (run: () => void): string => {
		const chunks: string[] = [];
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation((chunk: string | Uint8Array) => {
				chunks.push(String(chunk));
				return true;
			});
		try {
			run();
		} finally {
			stderr.mockRestore();
		}
		return chunks.join("");
	};

	it("asks for the AI Gateway, which nothing can detect", () => {
		expect(devEnvContext(props, "br-1", cwd).implyAiGateway).toBe(true);
	});

	it("layers the dotenv file over process.env, so one-time secrets survive a restart", () => {
		writeFileSync(
			join(cwd, ".env.local"),
			"NEON_AI_GATEWAY_TOKEN=nt_live_credfake0001_secret\n",
		);

		const { env } = devEnvContext(props, "br-1", cwd);

		expect(env.NEON_AI_GATEWAY_TOKEN).toBe("nt_live_credfake0001_secret");
		expect(env.PATH).toBe(process.env.PATH);
	});

	it("reads the same file `env pull` writes, preferring an existing .env", () => {
		writeFileSync(join(cwd, ".env"), "AWS_ACCESS_KEY_ID=cred-from-env\n");
		writeFileSync(
			join(cwd, ".env.local"),
			"AWS_ACCESS_KEY_ID=cred-from-env-local\n",
		);

		expect(devEnvContext(props, "br-1", cwd).env.AWS_ACCESS_KEY_ID).toBe(
			"cred-from-env",
		);
	});

	it("works in a directory with no dotenv file at all", () => {
		const { env } = devEnvContext(props, "br-1", cwd);
		expect(env.NEON_AI_GATEWAY_TOKEN).toBeUndefined();
	});

	it("reports secrets it resolved, and names the one thing that stops it recurring", () => {
		const logged = captureStderr(() =>
			reportDevCredential({
				issued: true,
				keys: ["NEON_AI_GATEWAY_TOKEN"],
				fresh: ["NEON_AI_GATEWAY_TOKEN"],
				revoked: [],
				superseded: [],
			}),
		);

		expect(logged).toContain("NEON_AI_GATEWAY_TOKEN");
		expect(logged).toContain("without writing them to a file");
		expect(logged).toContain("env pull");
	});

	it("says nothing when the credential was reused", () => {
		expect(
			captureStderr(() =>
				reportDevCredential({
					issued: false,
					keys: ["NEON_AI_GATEWAY_TOKEN"],
					fresh: [],
					revoked: [],
					superseded: [],
				}),
			),
		).toBe("");
		expect(captureStderr(() => reportDevCredential(undefined))).toBe("");
	});

	it("reports a revocation as a replacement, not as an orphan", () => {
		const logged = captureStderr(() =>
			reportDevCredential({
				issued: true,
				keys: ["NEON_AI_GATEWAY_TOKEN"],
				fresh: ["NEON_AI_GATEWAY_TOKEN"],
				revoked: ["cred-old-0001"],
				superseded: [],
			}),
		);

		expect(logged).toContain(
			"Revoked the leftover it replaced (cred-old-0001)",
		);
		expect(logged).not.toContain("without writing them to a file");
	});

	it("omits the branch rather than passing undefined when none is resolved", () => {
		expect(devEnvContext(props, undefined, cwd)).not.toHaveProperty(
			"branchId",
		);
	});
});
