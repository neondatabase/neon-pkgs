/**
 * `neon skills status` as the built CLI reports a GitHub it cannot read. The CLI honours
 * HTTPS_PROXY, so a local proxy stands in for a network that hangs or drops the connection.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { matchErrorCode } from "../errors.js";

const CLI = join(process.cwd(), "dist/cli.js");
const PROXY_VARS = /^(https?|all|no)_proxy$|^node_use_env_proxy$/i;

const cleanups: (() => void)[] = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

const projectWithNeonSkill = (): string => {
	const root = mkdtempSync(join(tmpdir(), "neon-skills-status-"));
	cleanups.push(() => rmSync(root, { force: true, recursive: true }));
	mkdirSync(join(root, "app"));
	mkdirSync(join(root, "config"));
	writeFileSync(
		join(root, "app/skills-lock.json"),
		JSON.stringify({
			version: 1,
			skills: {
				neon: {
					source: "neondatabase/agent-skills",
					sourceType: "github",
					skillPath: "skills/neon/SKILL.md",
					computedHash: "c".repeat(64),
				},
			},
		}),
	);
	return root;
};

/** A proxy that records each CONNECT target, then hangs or resets the connection. */
const startProxy = async (
	behaviour: "hang" | "reset",
): Promise<{ port: number; targets: string[] }> => {
	const targets: string[] = [];
	const sockets: Socket[] = [];
	const server: Server = createServer((socket) => {
		sockets.push(socket);
		socket.on("error", () => {});
		socket.once("data", (chunk) => {
			targets.push(chunk.toString("latin1").split(" ")[1] ?? "");
			if (behaviour === "reset") socket.resetAndDestroy();
		});
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	cleanups.push(() => {
		for (const socket of sockets) socket.destroy();
		server.close();
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("The proxy has no TCP port.");
	}
	return { port: address.port, targets };
};

const skillsStatus = (
	root: string,
	proxyPort: number,
): Promise<{ code: number | null; error: string }> => {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) => !PROXY_VARS.test(key) && key !== "NEON_API_KEY",
		),
	);
	const child = spawn(
		process.execPath,
		[
			CLI,
			"skills",
			"status",
			"--config-dir",
			join(root, "config"),
			"--no-analytics",
		],
		{
			cwd: join(root, "app"),
			env: { ...env, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` },
		},
	);
	cleanups.push(() => child.kill("SIGKILL"));
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	return new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => {
			const line = stderr
				.split("\n")
				.find((text) => text.startsWith("ERROR: "));
			resolve({ code, error: line?.slice("ERROR: ".length) ?? stderr });
		});
	});
};

describe("neon skills status without GitHub", () => {
	test("names GitHub and the time limit when GitHub does not answer", async () => {
		const root = projectWithNeonSkill();
		const proxy = await startProxy("hang");

		const { code, error } = await skillsStatus(root, proxy.port);

		expect(proxy.targets).toEqual(["api.github.com:443"]);
		expect(code).toBe(1);
		expect(error).toBe(
			"Could not read the file tree of neondatabase/agent-skills from api.github.com: the request did not finish within 10s. Check that this machine can reach api.github.com, then retry.",
		);
		expect(matchErrorCode(error)).toBe("REQUEST_TIMEOUT");
	}, 30_000);

	test("names GitHub when the connection fails", async () => {
		const root = projectWithNeonSkill();
		const proxy = await startProxy("reset");

		const { code, error } = await skillsStatus(root, proxy.port);

		expect(proxy.targets).toEqual(["api.github.com:443"]);
		expect(code).toBe(1);
		expect(error).toBe(
			"Could not read the file tree of neondatabase/agent-skills from api.github.com: the connection failed. Check your internet connection, then retry.",
		);
		expect(matchErrorCode(error)).toBe("NETWORK_ERROR");
	}, 30_000);
});
