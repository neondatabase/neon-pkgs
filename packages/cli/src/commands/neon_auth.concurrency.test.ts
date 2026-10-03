import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// `oauth-provider add|update` read the branch's auth base URL for the callback instructions
// while the provider write is in flight. Request counts can't show that, so the server holds
// the write until the read has arrived.

const BRANCH = "br-quiet-lake-123456";
const AUTH = `/projects/test/branches/${BRANCH}/auth`;
const BASE_URL = "https://auth.example.neon.tech";

const json = (res: ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
};

const run = async (args: string[], writeStatus: number) => {
	const seen: string[] = [];
	let releaseWrite: (() => void) | undefined;
	let readArrived = false;
	let writeAnsweredBeforeRead = false;
	const server = createServer((req, res) => {
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		seen.push(`${req.method} ${path}`);
		if (req.method === "GET" && path === AUTH) {
			readArrived = true;
			json(res, 200, { base_url: BASE_URL });
			releaseWrite?.();
			return;
		}
		let answered = false;
		const answer = () => {
			if (answered) return;
			answered = true;
			writeAnsweredBeforeRead ||= !readArrived;
			if (writeStatus === 200) {
				json(res, 200, {
					id: "github",
					type: "standard",
					client_id: "cid",
				});
			} else {
				json(res, writeStatus, { message: "provider write failed" });
			}
		};
		if (readArrived) {
			answer();
		} else {
			releaseWrite = answer;
			// A client that reads only after the write never sends the read; answer anyway so
			// the run ends and the ordering assertion reports it.
			setTimeout(answer, 2000);
		}
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	const root = mkdtempSync(join(tmpdir(), "neon-auth-overlap-"));
	try {
		const result = await new Promise<{
			code: number | null;
			stdout: string;
			stderr: string;
		}>((resolve) => {
			const cp = fork(
				join(process.cwd(), "dist/index.js"),
				[
					"neon-auth",
					"oauth-provider",
					...args,
					"--provider-id",
					"github",
					"--oauth-client-id",
					"cid",
					"--oauth-client-secret",
					"secret",
					"--project-id",
					"test",
					"--branch",
					BRANCH,
					"--output",
					"table",
					"--api-host",
					`http://127.0.0.1:${(server.address() as AddressInfo).port}`,
					"--api-key",
					"test-key",
					"--config-dir",
					join(root, "config"),
					"--context-file",
					join(root, ".neon"),
					"--no-analytics",
				],
				{
					stdio: "pipe",
					execArgv: ["--unhandled-rejections=strict"],
					env: { PATH: process.env.PATH },
				},
			);
			let stdout = "";
			let stderr = "";
			cp.stdout?.on("data", (d) => {
				stdout += d;
			});
			cp.stderr?.on("data", (d) => {
				stderr += d;
			});
			cp.on("close", (code) => resolve({ code, stdout, stderr }));
		});
		return { ...result, seen, writeAnsweredBeforeRead };
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		rmSync(root, { recursive: true, force: true });
	}
};

describe("neon-auth oauth-provider callback instructions", () => {
	for (const command of ["add", "update"]) {
		it(`${command} reads the base URL while the provider write is in flight`, async () => {
			const result = await run([command], 200);
			expect(result.stderr).toBe("");
			expect(result.code).toBe(0);
			expect(result.writeAnsweredBeforeRead).toBe(false);
			expect(result.seen.filter((s) => s === `GET ${AUTH}`)).toHaveLength(
				1,
			);
			expect(result.stdout).toContain(`${BASE_URL}/callback/github`);
			expect(result.stdout.indexOf("OAuth provider")).toBeLessThan(
				result.stdout.indexOf("callback/github"),
			);
		});

		it(`${command} prints no instructions when the write fails`, async () => {
			const result = await run([command], 500);
			expect(result.code).toBe(1);
			expect(result.stdout).not.toContain("callback/github");
			expect(result.stderr).toContain("provider write failed");
		});
	}
});
