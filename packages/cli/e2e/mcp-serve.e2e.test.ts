/**
 * `neon mcp serve` as an MCP client starts it: JSON-RPC on stdin and stdout, relayed to the live
 * Neon MCP server (mcp.neon.tech) with the harness API key. Every stdout line must parse as
 * JSON-RPC; anything else on stdout breaks the client reading it.
 */

import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { spawnCli } from "./helpers.js";

type JsonRpcMessage = {
	id?: number | string | null;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
};

const startServe = (args: string[] = [], apiKey?: string) => {
	const child = spawnCli(["mcp", "serve", ...args], {
		...(apiKey !== undefined ? { apiKey } : {}),
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const waiting = new Map<number, (message: JsonRpcMessage) => void>();
	const lines = createInterface({ input: child.stdout });
	lines.on("line", (line) => {
		const message: JsonRpcMessage = JSON.parse(line);
		if (typeof message.id === "number") waiting.get(message.id)?.(message);
	});
	const exited = new Promise<number | null>((resolve) =>
		child.on("close", resolve),
	);

	let nextId = 1;
	const request = (method: string, params: Record<string, unknown> = {}) => {
		const id = nextId++;
		const answered = new Promise<JsonRpcMessage>((resolve) =>
			waiting.set(id, resolve),
		);
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
		);
		return answered;
	};
	const notify = (method: string) => {
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
	};
	const initialize = () =>
		request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "neon-cli-e2e", version: "0" },
		});
	const close = async () => {
		child.stdin.end();
		return { code: await exited, stderr };
	};
	return { request, notify, initialize, close };
};

const toolNames = (message: JsonRpcMessage): string[] => {
	const tools = message.result?.tools;
	if (!Array.isArray(tools)) {
		throw new Error(
			`tools/list returned no tools: ${JSON.stringify(message)}`,
		);
	}
	return tools.map((tool: { name: string }) => tool.name);
};

describe("neon mcp serve against the live Neon MCP server", () => {
	it("initializes, lists tools, and calls one with the CLI's API key", async () => {
		const serve = startServe();

		const init = await serve.initialize();
		expect(init.error).toBeUndefined();
		expect(init.result?.serverInfo).toMatchObject({
			name: "mcp-server-neon",
		});
		serve.notify("notifications/initialized");

		const tools = toolNames(await serve.request("tools/list"));
		expect(tools).toContain("list_projects");
		expect(tools).toContain("delete_project");

		const call = await serve.request("tools/call", {
			name: "list_projects",
			arguments: {},
		});
		expect(call.error).toBeUndefined();
		expect(call.result?.isError).not.toBe(true);

		const { code, stderr } = await serve.close();
		expect(code, stderr).toBe(0);
	});

	it("hides write tools with --read-only", async () => {
		const serve = startServe(["--read-only"]);

		await serve.initialize();
		serve.notify("notifications/initialized");
		const tools = toolNames(await serve.request("tools/list"));
		expect(tools).toContain("list_projects");
		expect(tools).not.toContain("delete_project");

		expect((await serve.close()).code).toBe(0);
	});

	it("answers each request with the CLI's message when the key is rejected", async () => {
		const serve = startServe([], "napi_e2e_rejected_key");

		const init = await serve.initialize();
		expect(init.error?.message).toBe(
			"Authentication failed: the Neon API rejected the API key. Check --api-key or NEON_API_KEY.",
		);

		await serve.close();
	});
});
