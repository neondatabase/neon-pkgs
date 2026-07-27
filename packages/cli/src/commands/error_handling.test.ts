import { fork } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { describe, expect, it } from "vitest";

import { test } from "../test_utils/fixtures";

// These tests guard the CLI's *top-level* error router (`handleError` + the retry loop in
// `index.ts`) end to end — the cross-cutting behavior that's easy to break during a refactor
// and isn't otherwise covered by the per-command specs.
describe("top-level error handling", () => {
	// A real ECONNREFUSED (via `unreachableHost`) must surface the single human-readable
	// "check your connection" line, not a cryptic `fetch failed` / empty axios message, and
	// exit non-zero. Uses an axios-path command (`projects list`); the fetch/SDK error shape
	// is covered by the unit tests in `errors.test.ts`.
	test("a network failure surfaces a friendly message and exits 1", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["projects", "list"], {
			unreachableHost: true,
			code: 1,
			stderr: expect.stringContaining(
				"Could not reach the Neon API. Please check your internet connection",
			),
		});
	});

	// `.strictCommands()` must keep rejecting unknown (sub)commands with a non-zero exit. A
	// single unknown token would hit the help middleware, so use an unknown *subcommand*.
	test("an unknown command exits 1 with a helpful message", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["projects", "definitely-not-a-subcommand"], {
			code: 1,
			stderr: expect.stringContaining("Unknown command"),
		});
	});

	// Regression guard for the deliberate "do not retry at the command boundary" decision:
	// re-running a whole command on failure could re-fire a non-idempotent step. A server
	// error on `projects create` must therefore reach the API exactly once (never twice) and
	// exit 1. The mock counts the POSTs itself, so this asserts the real request count.
	it("does not retry a create on a server error (no double-create)", async () => {
		let createRequests = 0;
		const app = express();
		app.use(express.json());
		app.post("/projects", (_req, res) => {
			createRequests += 1;
			res.status(500).json({ message: "Internal Server Error" });
		});
		app.use((_req, res) => res.status(404).json({ message: "Not Found" }));

		const server = await new Promise<Server>((resolve) => {
			const s = app.listen(0, () => {
				resolve(s);
			});
		});
		const port = (server.address() as AddressInfo).port;

		try {
			const code = await new Promise<number>((resolve, reject) => {
				const cp = fork(
					join(process.cwd(), "./dist/index.js"),
					[
						"--api-host",
						`http://localhost:${port}`,
						"--output",
						"yaml",
						"--api-key",
						"test-key",
						"--no-analytics",
						"projects",
						"create",
						"--name",
						"regression-no-double-create",
					],
					{
						stdio: "pipe",
						// Mirror the shared harness env; CI=true keeps create non-interactive.
						env: {
							PATH: `mocks/bin:${process.env.PATH}`,
							CI: "true",
						},
					},
				);
				cp.on("error", reject);
				cp.on("close", (exitCode) => {
					resolve(exitCode ?? -1);
				});
			});

			expect(code).toBe(1);
			expect(createRequests).toBe(1);
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => {
					if (err) {
						reject(err);
					} else {
						resolve();
					}
				});
			});
		}
	});
});

// A 401 makes the CLI clear the OAuth token it stored, so that the next run logs in again.
// Which credentials it may clear, and from where, depends entirely on how the failing
// request was authorized — these guard both halves of that.
describe("401 credential handling", () => {
	// Serves 401 to everything and hands the test a real port.
	const unauthorizedServer = async (): Promise<{
		port: number;
		close: () => Promise<void>;
	}> => {
		const app = express();
		app.use((_req, res) =>
			res.status(401).json({ message: "Unauthorized" }),
		);
		const server = await new Promise<Server>((resolve) => {
			const s = app.listen(0, () => {
				resolve(s);
			});
		});
		return {
			port: (server.address() as AddressInfo).port,
			close: () =>
				new Promise<void>((resolve, reject) => {
					server.close((err) => (err ? reject(err) : resolve()));
				}),
		};
	};

	// Runs the built CLI with both the config dir and the *default* config dir pointed at
	// throwaway directories, so a misdirected delete can't reach the real ~/.config/neonctl.
	const runCli = async (
		args: string[],
		env: Record<string, string>,
	): Promise<{ code: number; output: string }> => {
		let output = "";
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
				output += String(c);
			});
			cp.stderr?.on("data", (c) => {
				output += String(c);
			});
			cp.on("error", reject);
			cp.on("close", (exitCode) => {
				resolve(exitCode ?? -1);
			});
		});
		return { code, output };
	};

	const writeCredentials = (configDir: string): string => {
		mkdirSync(configDir, { recursive: true });
		const path = join(configDir, "credentials.json");
		writeFileSync(
			path,
			JSON.stringify({
				access_token: "stored-access-token",
				refresh_token: "stored-refresh-token",
				// Comfortably unexpired, so the CLI uses it as-is instead of refreshing.
				expires_at: Date.now() + 60 * 60 * 1000,
				user_id: "test-user",
			}),
		);
		return path;
	};

	// An explicit --api-key never consults the stored token, so its rejection says nothing
	// about whether that token is still valid. Clearing it would sign the user out of an
	// account the failed request never touched.
	it("leaves stored credentials alone when the rejected key came from --api-key", async () => {
		const server = await unauthorizedServer();
		const home = mkdtempSync(join(tmpdir(), "neon-401-apikey-"));
		const configDir = join(home, "neonctl");
		const credentials = writeCredentials(configDir);

		try {
			const { code, output } = await runCli(
				[
					"--api-host",
					`http://localhost:${server.port}`,
					"--config-dir",
					configDir,
					"--api-key",
					"rejected-key",
					"--no-analytics",
					"projects",
					"list",
				],
				{ XDG_CONFIG_HOME: home },
			);

			expect(existsSync(credentials)).toBe(true);
			expect(code).toBe(1);
			// The homebrew-core formula asserts on this exact phrase; keep it in the message.
			expect(output).toContain("Authentication failed");
		} finally {
			await server.close();
			rmSync(home, { recursive: true, force: true });
		}
	});

	// The complement: when the stored token itself is what got rejected, it must be cleared —
	// and from the --config-dir actually in use, not from the default location.
	it("clears the stored credentials in --config-dir when they are what was rejected", async () => {
		const server = await unauthorizedServer();
		const home = mkdtempSync(join(tmpdir(), "neon-401-stored-"));
		// Deliberately not $XDG_CONFIG_HOME/neonctl: if the handler falls back to the default
		// directory instead of honoring --config-dir, this file survives and the test fails.
		const configDir = join(home, "explicit-config-dir");
		const credentials = writeCredentials(configDir);
		const defaultCredentials = writeCredentials(join(home, "neonctl"));

		try {
			const { code } = await runCli(
				[
					"--api-host",
					`http://localhost:${server.port}`,
					"--config-dir",
					configDir,
					"--no-analytics",
					"projects",
					"list",
				],
				{ XDG_CONFIG_HOME: home },
			);

			expect(existsSync(credentials)).toBe(false);
			expect(existsSync(defaultCredentials)).toBe(true);
			expect(code).toBe(1);
		} finally {
			await server.close();
			rmSync(home, { recursive: true, force: true });
		}
	});
});
