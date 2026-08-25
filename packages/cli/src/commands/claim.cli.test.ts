/** `testCliCommand` always passes `--api-key`, which `claim` rejects. */

import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import strip from "strip-ansi";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import {
	readClaimableCredentials,
	writeClaimableCredentials,
} from "../claimable/state.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

let unreachableOrigin = "";
beforeAll(async () => {
	unreachableOrigin = await new Promise<string>((res, rej) => {
		const probe = createServer();
		probe.on("error", rej);
		probe.listen(0, "localhost", () => {
			const { port } = probe.address() as AddressInfo;
			probe.close((err) =>
				err ? rej(err) : res(`http://localhost:${port}`),
			);
		});
	});
});

type Run = {
	code: number | null;
	stdout: string;
	stderr: string;
	configDir: string;
};

const makeWorkspace = (): { configDir: string; contextFile: string } => {
	const dir = mkdtempSync(join(tmpdir(), "neon-claim-cli-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, ".git"), "gitdir: test");
	const configDir = join(dir, "config");
	mkdirSync(configDir);
	return { configDir, contextFile: join(dir, ".neon") };
};

const BOX = /[┌┐└┘├┤┬┴┼─│]/;

const runCli = (
	args: string[],
	env: NodeJS.ProcessEnv = {},
	setup?: (workspace: { configDir: string; contextFile: string }) => void,
): Promise<Run> => {
	const { configDir, contextFile } = makeWorkspace();
	setup?.({ configDir, contextFile });
	return new Promise((res, rej) => {
		const cp = fork(
			join(process.cwd(), "./dist/cli.js"),
			[
				"--no-analytics",
				"--config-dir",
				configDir,
				"--context-file",
				contextFile,
				"--claimable-host",
				unreachableOrigin,
				...args,
			],
			{
				stdio: "pipe",
				env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), ...env },
			},
		);
		cp.stdin?.end();
		let stdout = "";
		let stderr = "";
		cp.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		cp.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		cp.on("error", rej);
		cp.on("close", (code) =>
			res({
				code,
				stdout: strip(stdout),
				stderr: strip(stderr),
				configDir,
			}),
		);
	});
};

const reachedClaimableService = (stderr: string) =>
	stderr.includes(`Could not reach Claimable Neon at ${unreachableOrigin}`);

describe("claim create with ambient credentials", () => {
	test.each([
		{ NEON_API_KEY: "napi_ambient" },
		{ NEON_PROFILE: "work" },
		{ NEON_API_KEY: "napi_ambient", NEON_PROFILE: "work" },
	])("creates without warning or throwing when %o is set", async (env) => {
		const { code, stderr } = await runCli(
			["claim", "create", "--no-env-pull"],
			env,
		);

		expect(code).toBe(1);
		expect(reachedClaimableService(stderr)).toBe(true);
		expect(stderr).not.toContain("Unset");
		expect(stderr).not.toContain("NEON_API_KEY or NEON_PROFILE is set");
		expect(stderr).not.toContain("does not use a Neon account credential");
	});
});

describe("claim create with explicit credential flags", () => {
	test.each([
		["--api-key", "napi_flag"],
		["--profile", "work"],
	] as const)("%s still fails before contacting Claimable Neon", async (flag, value) => {
		const { code, stderr } = await runCli([
			flag,
			value,
			"claim",
			"create",
			"--no-env-pull",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain(
			"Claimable Neon does not use a Neon account credential. Remove --api-key or --profile.",
		);
		expect(reachedClaimableService(stderr)).toBe(false);
	});
});

const expiredCredentials = {
	version: 1 as const,
	origin: "https://claimable.neon.tech",
	registrationId: "reg_expired",
	projectId: "quiet-fog-12345678",
	branchId: "br-quiet-fog-12345678",
	identityAssertion: "expired-assertion",
	expiresAt: "2026-08-24T12:00:00.000Z",
	assertionExpires: 1,
};

describe("claim status and delete after the assertion expires", () => {
	test("status reports expired without contacting the service", async () => {
		const { code, stdout, stderr } = await runCli(
			[
				"claim",
				"status",
				expiredCredentials.projectId,
				"--output",
				"json",
			],
			{},
			({ configDir }) => {
				writeClaimableCredentials(configDir, expiredCredentials);
			},
		);

		expect(code).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toMatchObject({
			project_id: expiredCredentials.projectId,
			state: "expired",
			reconciled: false,
		});
		expect(reachedClaimableService(stderr)).toBe(false);
	});

	test("delete drops a listed project that has no .neon", async () => {
		const { code, stdout, stderr, configDir } = await runCli(
			[
				"claim",
				"delete",
				expiredCredentials.projectId,
				"--yes",
				"--output",
				"json",
			],
			{},
			({ configDir }) => {
				writeClaimableCredentials(configDir, expiredCredentials);
			},
		);

		expect(code).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({
			project_id: expiredCredentials.projectId,
			state: "cleared",
		});
		expect(reachedClaimableService(stderr)).toBe(false);
		expect(
			readClaimableCredentials(configDir, expiredCredentials.projectId),
		).toBeNull();
	});

	test("accept refuses an expired assertion without contacting the service", async () => {
		const { code, stderr } = await runCli(
			["claim", "accept", expiredCredentials.projectId, "--no-open"],
			{},
			({ configDir }) => {
				writeClaimableCredentials(configDir, expiredCredentials);
			},
		);

		expect(code).toBe(1);
		expect(stderr).toContain("has expired");
		expect(reachedClaimableService(stderr)).toBe(false);
	});
});

describe("claim list table output", () => {
	test("empty list is a message, not a box table", async () => {
		const { code, stdout, stderr } = await runCli(["claim", "list"]);

		expect(code).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).not.toMatch(BOX);
		expect(stdout).toContain(
			"No Claimable Neon projects are saved on this machine.",
		);
	});

	test("prints every column at full width without boxes", async () => {
		const projectId = "wandering-haze-25754674";
		const branchId = "br-main-branch-123456";
		const origin = "https://claimable.neon.tech";
		const expiresAt = "2027-08-24T12:00:00.000Z";
		const { code, stdout, stderr } = await runCli(
			["claim", "list"],
			{},
			({ configDir }) => {
				writeClaimableCredentials(configDir, {
					version: 1,
					origin,
					registrationId: "reg_test",
					projectId,
					branchId,
					identityAssertion: "assertion",
					expiresAt,
				});
			},
		);

		expect(code).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).not.toMatch(BOX);
		expect(stdout).toContain("Project Id");
		expect(stdout).toContain("Branch Id");
		expect(stdout).toContain("State");
		expect(stdout).toContain("Project Expires At");
		expect(stdout).toContain("Origin");
		expect(stdout).toContain("unclaimed");
		expect(stdout).toContain(projectId);
		expect(stdout).toContain(branchId);
		expect(stdout).toContain(expiresAt);
		expect(stdout).toContain(origin);
		expect(stdout.trimEnd().split("\n")).toHaveLength(2);
	});

	test("marks a past project expiry as expired even when the assertion is live", async () => {
		const projectId = "wandering-haze-25754674";
		const { code, stdout, stderr } = await runCli(
			["claim", "list"],
			{},
			({ configDir }) => {
				writeClaimableCredentials(configDir, {
					version: 1,
					origin: "https://claimable.neon.tech",
					registrationId: "reg_test",
					projectId,
					branchId: "br-main-branch-123456",
					identityAssertion: "assertion",
					expiresAt: "2026-08-24T12:00:00.000Z",
					assertionExpires: 4_000_000_000,
				});
			},
		);

		expect(code).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toContain("expired");
		expect(stdout).not.toContain("unclaimed");
		expect(stdout).toContain(projectId);
	});

	test("marks a locally expired assertion as expired", async () => {
		const projectId = "wandering-haze-25754674";
		const { code, stdout, stderr } = await runCli(
			["claim", "list"],
			{},
			({ configDir }) => {
				writeClaimableCredentials(configDir, {
					version: 1,
					origin: "https://claimable.neon.tech",
					registrationId: "reg_test",
					projectId,
					branchId: "br-main-branch-123456",
					identityAssertion: "assertion",
					expiresAt: "2026-08-24T12:00:00.000Z",
					assertionExpires: 1_700_000_000,
				});
			},
		);

		expect(code).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toContain("expired");
		expect(stdout).not.toContain("unclaimed");
		expect(stdout).toContain(projectId);
	});
});
