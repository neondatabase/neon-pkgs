import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect } from "vitest";

import { test } from "../test_utils/fixtures.js";
import { DEFAULT_ASK_URL, resolveAskUrl } from "./ask.js";

const ASK_ENV = { CI: "1" };

async function withAskServer(
	handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void,
	run: (url: string) => Promise<void>,
): Promise<void> {
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			let body: unknown;
			if (raw.trim() !== "") {
				try {
					body = JSON.parse(raw);
				} catch {
					res.statusCode = 400;
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify({ error: "invalid json" }));
					return;
				}
			}
			handler(req, res, body);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	try {
		await run(`http://127.0.0.1:${port}/ask`);
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
	}
}

describe("resolveAskUrl", () => {
	test("uses the hosted assistant by default", () => {
		expect(resolveAskUrl({})).toBe(DEFAULT_ASK_URL);
		expect(DEFAULT_ASK_URL).toMatch(/\/ask$/);
	});

	test("prefers --url over NEON_ASK_URL", () => {
		expect(
			resolveAskUrl({
				url: " http://127.0.0.1:9/ask ",
				envUrl: "https://example.test/ask",
			}),
		).toBe("http://127.0.0.1:9/ask");
	});

	test("uses NEON_ASK_URL when --url is omitted", () => {
		expect(resolveAskUrl({ envUrl: " https://example.test/ask " })).toBe(
			"https://example.test/ask",
		);
	});
});

describe("neon ask", () => {
	test("prints the assistant text without logging in", async ({
		testCliCommand,
	}) => {
		const seen: Array<{
			method?: string;
			authorization: string | undefined;
			body: unknown;
		}> = [];
		await withAskServer(
			(req, res, body) => {
				seen.push({
					method: req.method,
					authorization: req.headers.authorization,
					body,
				});
				res.statusCode = 200;
				res.setHeader("Content-Type", "application/json");
				res.end(
					JSON.stringify({
						text: "Schema-only branches copy schema, not data.",
					}),
				);
			},
			async (url) => {
				const { stdout, stderr } = await testCliCommand(
					[
						"ask",
						"--prompt",
						"How do schema-only branches work?",
						"--url",
						url,
					],
					{
						apiKey: false,
						outputTable: true,
						snapshot: false,
						env: ASK_ENV,
					},
				);
				expect(stdout).toBe(
					"Schema-only branches copy schema, not data.\n",
				);
				expect(stderr).toMatch(/Asking the Neon assistant/);
				expect(stderr).not.toMatch(/Cannot run interactive auth in CI/);
				expect(stderr).not.toMatch(/Not Found/);
			},
		);
		expect(seen).toEqual([
			{
				method: "POST",
				authorization: undefined,
				body: { prompt: "How do schema-only branches work?" },
			},
		]);
	});

	test("prints json as { text }", async ({ testCliCommand }) => {
		await withAskServer(
			(_req, res) => {
				res.statusCode = 200;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ text: "A Neon branch is a copy." }));
			},
			async (url) => {
				const { stdout } = await testCliCommand(
					["ask", "--prompt", "What is a branch?", "--url", url],
					{
						apiKey: false,
						output: "json",
						snapshot: false,
						env: ASK_ENV,
					},
				);
				expect(JSON.parse(stdout)).toEqual({
					text: "A Neon branch is a copy.",
				});
			},
		);
	});

	test("uses NEON_ASK_URL when --url is omitted", async ({
		testCliCommand,
	}) => {
		await withAskServer(
			(_req, res) => {
				res.statusCode = 200;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ text: "from-env" }));
			},
			async (url) => {
				const { stdout } = await testCliCommand(
					["ask", "--prompt", "What is Neon?"],
					{
						apiKey: false,
						outputTable: true,
						snapshot: false,
						env: { ...ASK_ENV, NEON_ASK_URL: url },
					},
				);
				expect(stdout).toBe("from-env\n");
			},
		);
	});

	test("prints the server error on 4xx", async ({ testCliCommand }) => {
		await withAskServer(
			(_req, res) => {
				res.statusCode = 400;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ error: "prompt is required" }));
			},
			async (url) => {
				const { stdout, stderr } = await testCliCommand(
					["ask", "--prompt", "hello", "--url", url],
					{
						apiKey: false,
						outputTable: true,
						snapshot: false,
						code: 1,
						env: ASK_ENV,
					},
				);
				expect(stdout).toBe("");
				expect(stderr).toMatch(/prompt is required/);
			},
		);
	});

	test("fails without --prompt", async ({ testCliCommand }) => {
		const { stdout, stderr } = await testCliCommand(["ask"], {
			apiKey: false,
			snapshot: false,
			code: 1,
			env: ASK_ENV,
		});
		expect(stdout).toBe("");
		expect(stderr).toMatch(/prompt/i);
	});

	test("fails on empty --prompt", async ({ testCliCommand }) => {
		const { stderr } = await testCliCommand(["ask", "--prompt", ""], {
			apiKey: false,
			snapshot: false,
			code: 1,
			env: ASK_ENV,
		});
		expect(stderr).toMatch(/--prompt needs a value/);
	});

	test("help lists --prompt and not the hosted URL", async ({
		testCliCommand,
	}) => {
		const { stderr } = await testCliCommand(["ask", "--help"], {
			apiKey: false,
			snapshot: false,
			env: ASK_ENV,
		});
		expect(stderr).toMatch(/--prompt/);
		expect(stderr).not.toMatch(/br-frosty-cell/);
		expect(stderr).not.toMatch(/--url/);
	});
});
