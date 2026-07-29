import { fork } from "node:child_process";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import express from "express";
import { describe, expect, it } from "vitest";

// A key shaped like a real one, so a regression can't pass by the value looking harmless.
const API_KEY = "napi_test_help_leak_guard_9f3a1c";

const runCli = async (
	args: string[],
	env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> => {
	let stdout = "";
	let stderr = "";
	const code = await new Promise<number>((resolve, reject) => {
		const cp = fork(join(process.cwd(), "./dist/index.js"), args, {
			stdio: "pipe",
			env: {
				PATH: `mocks/bin:${process.env.PATH}`,
				CI: "true",
				...env,
			},
		});
		cp.stdout?.on("data", (c) => {
			stdout += String(c);
		});
		cp.stderr?.on("data", (c) => {
			stderr += String(c);
		});
		cp.on("error", reject);
		cp.on("close", (exitCode) => {
			resolve(exitCode ?? -1);
		});
	});
	return { code, stdout, stderr };
};

// yargs prints every option's default into its help output, so resolving NEON_API_KEY in
// the `--api-key` default printed the user's key on any help screen — including into CI
// logs and pasted bug reports.
describe("help output never prints secrets", () => {
	it("does not print NEON_API_KEY in top-level help", async () => {
		const { stdout, stderr } = await runCli(["--help"], {
			NEON_API_KEY: API_KEY,
		});

		expect(stderr + stdout).not.toContain(API_KEY);
		// The option itself is still documented, and says where it reads from.
		expect(stderr).toContain("--api-key");
		expect(stderr).toContain("NEON_API_KEY");
	});

	it("does not print NEON_API_KEY in subcommand help", async () => {
		const { stdout, stderr } = await runCli(
			["projects", "list", "--help"],
			{ NEON_API_KEY: API_KEY },
		);

		expect(stderr + stdout).not.toContain(API_KEY);
		expect(stderr).toContain("--api-key");
	});

	it("does not print an explicit --api-key value in help", async () => {
		const { stdout, stderr } = await runCli([
			"--api-key",
			API_KEY,
			"--help",
		]);

		expect(stderr + stdout).not.toContain(API_KEY);
	});
});

// The key must still authenticate requests when it comes from the environment: moving the
// lookup out of the yargs default is only correct if this keeps working.
describe("NEON_API_KEY still authorizes requests", () => {
	it("sends the environment key as the bearer token", async () => {
		const authHeaders: (string | undefined)[] = [];
		const app = express();
		app.use((req, _res, next) => {
			authHeaders.push(req.headers.authorization);
			next();
		});
		app.get("/projects/shared", (_req, res) => {
			res.json({ projects: [] });
		});
		app.get("/projects", (_req, res) => {
			res.json({ projects: [] });
		});
		app.use((_req, res) => res.status(404).json({ message: "Not Found" }));

		const server = await new Promise<Server>((resolve) => {
			const s = app.listen(0, () => {
				resolve(s);
			});
		});
		const { port } = server.address() as AddressInfo;

		try {
			const { code } = await runCli(
				[
					"--api-host",
					`http://localhost:${port}`,
					"--no-analytics",
					"projects",
					"list",
				],
				{ NEON_API_KEY: API_KEY },
			);

			expect(code).toBe(0);
			expect(authHeaders).toContain(`Bearer ${API_KEY}`);
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		}
	});
});
