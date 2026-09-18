import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { test } from "../test_utils/fixtures.js";

const startOauthProbe = (): Promise<{
	url: string;
	hits: () => number;
	close: () => Promise<void>;
}> =>
	new Promise((resolve) => {
		let hits = 0;
		const server = createServer((_req, res) => {
			hits += 1;
			res.statusCode = 404;
			res.end("no");
		});
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${port}`,
				hits: () => hits,
				close: () =>
					new Promise((done, fail) => {
						server.close((err) => (err ? fail(err) : done()));
					}),
			});
		});
	});

describe("unattended CLI authentication", () => {
	const dirs: string[] = [];
	const probes: Array<{ close: () => Promise<void> }> = [];

	afterEach(async () => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
		await Promise.all(probes.splice(0).map((probe) => probe.close()));
	});

	const isolated = async () => {
		const dir = mkdtempSync(join(tmpdir(), "neon-unattended-auth-"));
		dirs.push(dir);
		const probe = await startOauthProbe();
		probes.push(probe);
		return {
			dir,
			probe,
			flags: [
				"--config-dir",
				join(dir, "config"),
				"--context-file",
				join(dir, ".neon"),
				"--oauth-host",
				probe.url,
			],
		};
	};

	const remedies =
		/Pass --api-key <key>, set NEON_API_KEY, or run `neon auth` in an interactive terminal before retrying/;

	test("link -y names credentials and does not start OAuth", async ({
		testCliCommand,
	}) => {
		const { flags, probe } = await isolated();
		const { stderr } = await testCliCommand(["link", "-y", ...flags], {
			apiKey: false,
			code: 1,
			snapshot: false,
		});
		expect(stderr).toMatch(
			/Cannot run interactive auth in unattended mode/,
		);
		expect(stderr).toMatch(remedies);
		expect(probe.hits()).toBe(0);
	});

	test("link --project-id -y fails before lookup and does not start OAuth", async ({
		testCliCommand,
	}) => {
		const { flags, probe } = await isolated();
		const { stderr } = await testCliCommand(
			["link", "--project-id", "test", "-y", ...flags],
			{
				apiKey: false,
				code: 1,
				snapshot: false,
			},
		);
		expect(stderr).toMatch(/unattended mode/);
		expect(stderr).toMatch(remedies);
		expect(stderr).not.toMatch(/Project 'test' not found/);
		expect(probe.hits()).toBe(0);
	});

	test("link --yes is the same as -y", async ({ testCliCommand }) => {
		const { flags, probe } = await isolated();
		const { stderr } = await testCliCommand(["link", "--yes", ...flags], {
			apiKey: false,
			code: 1,
			snapshot: false,
		});
		expect(stderr).toMatch(/unattended mode/);
		expect(probe.hits()).toBe(0);
	});

	test("link with piped streams refuses OAuth without -y", async ({
		testCliCommand,
	}) => {
		const { flags, probe } = await isolated();
		const { stderr } = await testCliCommand(["link", ...flags], {
			apiKey: false,
			code: 1,
			snapshot: false,
		});
		expect(stderr).toMatch(/unattended mode/);
		expect(stderr).toMatch(remedies);
		expect(probe.hits()).toBe(0);
	});

	test("projects list with piped streams refuses OAuth", async ({
		testCliCommand,
	}) => {
		const { flags, probe } = await isolated();
		const { stderr } = await testCliCommand(
			["projects", "list", ...flags],
			{
				apiKey: false,
				code: 1,
				snapshot: false,
			},
		);
		expect(stderr).toMatch(/unattended mode/);
		expect(stderr).toMatch(remedies);
		expect(probe.hits()).toBe(0);
	});

	test("auth with piped streams names a terminal and --force-auth", async ({
		testCliCommand,
	}) => {
		const { flags, probe } = await isolated();
		const { stderr } = await testCliCommand(["auth", ...flags], {
			apiKey: false,
			code: 1,
			snapshot: false,
		});
		expect(stderr).toMatch(
			/Cannot run interactive auth in unattended mode/,
		);
		expect(stderr).toMatch(
			/Re-run `neon auth` in an interactive terminal, or pass --force-auth/,
		);
		expect(stderr).not.toMatch(/Pass --api-key/);
		expect(probe.hits()).toBe(0);
	});

	test("link -y in CI keeps the CI prefix", async ({ testCliCommand }) => {
		const { flags, probe } = await isolated();
		const { stderr } = await testCliCommand(["link", "-y", ...flags], {
			apiKey: false,
			code: 1,
			snapshot: false,
			env: { CI: "true" },
		});
		expect(stderr).toMatch(/Cannot run interactive auth in CI/);
		expect(stderr).toMatch(remedies);
		expect(probe.hits()).toBe(0);
	});

	test("--force-auth still starts OAuth from unattended streams", async ({
		testCliCommand,
	}) => {
		const { flags, probe } = await isolated();
		await testCliCommand(["link", "-y", "--force-auth", ...flags], {
			apiKey: false,
			code: 1,
			snapshot: false,
		});
		expect(probe.hits()).toBeGreaterThan(0);
	}, 15_000);
});
