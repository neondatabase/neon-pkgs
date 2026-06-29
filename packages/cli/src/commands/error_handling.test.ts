import { fork } from "node:child_process";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
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
