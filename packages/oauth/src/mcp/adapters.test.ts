// Contract tests for the MCP adapter contract, then one thin smoke test per adapter proving it
// maps 401 / 200 / metadata through the contract.

import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticate } from "../adapter";
import type { FakeAuthServer } from "../testing/fake-auth-server";
import { startFakeAuthServer } from "../testing/fake-auth-server";
import { createVerifier, OAuthConfigError } from "../verify";
import type { AuthedRequest } from "./express";
import { expressMcp, expressMcpBearerAuth } from "./express";
import { honoMcp, honoMcpBearerAuth } from "./hono";
import type { McpAuth } from "./index";
import { createMcpAuth, routeMcpMetadata } from "./index";
import { createMetadataHandlers, withMcpAuth } from "./next";
import { type AuthedIncomingMessage, nodeMcp, nodeMcpBearerAuth } from "./node";

const RESOURCE = "http://api.test/mcp";
const META = "/.well-known/oauth-protected-resource/mcp";

let fake: FakeAuthServer;
let servers: Server[] = [];
beforeEach(async () => {
	fake = await startFakeAuthServer();
});
afterEach(async () => {
	await fake.close();
	await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
	servers = [];
});

const mcp = () => createMcpAuth({ baseUrl: fake.issuer, resource: RESOURCE });
const bearer = async () => ({
	authorization: `Bearer ${await fake.sign()}`,
});

async function listen(
	handler: Parameters<typeof createServer>[1],
): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("core contract", () => {
	it("authenticate returns { ok: true, auth } for a valid token", async () => {
		const out = await authenticate(
			mcp(),
			new Request(RESOURCE, { headers: await bearer() }),
		);
		expect(out).toMatchObject({ ok: true, auth: { sub: "user-1" } });
	});

	it("authenticate returns { ok: false, response } with the challenge", async () => {
		const out = await authenticate(mcp(), new Request(RESOURCE));
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.response.status).toBe(401);
		expect(out.response.headers.get("www-authenticate")).toContain(
			`resource_metadata="http://api.test${META}"`,
		);
	});

	it("routeMcpMetadata answers metadata and ignores everything else", () => {
		const m = mcp();
		expect(
			routeMcpMetadata(m, new Request(`http://api.test${META}`))?.status,
		).toBe(200);
		expect(
			routeMcpMetadata(
				m,
				new Request(`http://api.test${META}`, { method: "OPTIONS" }),
			)?.status,
		).toBe(204);
		expect(routeMcpMetadata(m, new Request(RESOURCE))).toBeUndefined();
	});
});

describe("hono adapter", () => {
	it("maps 401 / 200 / metadata", async () => {
		const app = new Hono();
		app.use(honoMcp(mcp()));
		app.post("/mcp", (c) => c.json({ ok: true }));
		expect((await app.request("/mcp", { method: "POST" })).status).toBe(
			401,
		);
		expect(
			(
				await app.request("/mcp", {
					method: "POST",
					headers: await bearer(),
				})
			).status,
		).toBe(200);
		expect((await app.request(META)).status).toBe(200);
	});
});

describe("node adapter", () => {
	it("sets req.auth to the SDK AuthInfo and req.authResult to the AuthResult", async () => {
		const m = mcp();
		const mw = nodeMcpBearerAuth(m);
		const url = await listen((req, res) =>
			mw(req, res, () => {
				const r = req as AuthedIncomingMessage;
				res.end(
					JSON.stringify({
						auth: r.auth,
						authResult: r.authResult,
					}),
				);
			}),
		);
		const body = await (
			await fetch(url, { headers: await bearer() })
		).json();
		expect(body.auth).toMatchObject({
			scopes: expect.any(Array),
			clientId: expect.any(String),
			extra: { claims: { sub: "user-1" } },
		});
		expect(body.auth.token).toBe(body.authResult.token);
		expect(body.authResult).toMatchObject({ sub: "user-1" });
		expect(body.auth.sub).toBeUndefined();
	});

	it("nodeMcp maps 401 / 200 / metadata and falls through otherwise", async () => {
		const mw = nodeMcp(mcp());
		const url = await listen((req, res) =>
			mw(req, res, () => res.end("fell through")),
		);
		expect((await fetch(`${url}/mcp`, { method: "POST" })).status).toBe(
			401,
		);
		const ok = await fetch(`${url}/mcp`, {
			method: "POST",
			headers: await bearer(),
		});
		expect(await ok.text()).toBe("fell through");
		expect(await (await fetch(url + META)).json()).toMatchObject({
			resource: RESOURCE,
		});
		expect(await (await fetch(`${url}/other`)).text()).toBe("fell through");
	});
});

describe("express adapter", () => {
	it("maps 401 / 200 (req.auth is AuthInfo, req.authResult is AuthResult) / metadata", async () => {
		const app = express();
		app.use(expressMcp(mcp()));
		app.use(express.json());
		app.post(
			"/mcp",
			(req, res) =>
				void res.json({ sub: (req as AuthedRequest).authResult.sub }),
		);
		app.get("/guarded", expressMcpBearerAuth(mcp()), (req, res) => {
			const r = req as AuthedRequest;
			void res.json({
				sub: r.authResult.sub,
				token: r.auth.token === r.authResult.token,
				claimsSub: (r.auth.extra?.claims as { sub: string }).sub,
			});
		});
		const url = await listen(app);

		const denied = await fetch(`${url}/mcp`, { method: "POST" });
		expect(denied.status).toBe(401);
		expect(denied.headers.get("www-authenticate")).toContain(
			"resource_metadata=",
		);
		expect(
			await (
				await fetch(`${url}/mcp`, {
					method: "POST",
					headers: await bearer(),
				})
			).json(),
		).toEqual({ sub: "user-1" });
		expect(await (await fetch(url + META)).json()).toMatchObject({
			resource: RESOURCE,
		});
		expect((await fetch(`${url}/guarded`)).status).toBe(401);
		expect(
			await (
				await fetch(`${url}/guarded`, { headers: await bearer() })
			).json(),
		).toEqual({ sub: "user-1", token: true, claimsSub: "user-1" });
	});
});

describe("guards are built when the middleware is created", () => {
	it("MCP factories create without network I/O", () => {
		const spy = vi.spyOn(globalThis, "fetch");
		try {
			const m = mcp();
			nodeMcp(m);
			nodeMcpBearerAuth(m);
			expressMcp(m);
			expressMcpBearerAuth(m);
			honoMcp(m);
			withMcpAuth(m, () => new Response());
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("authenticate builds its guard per call and rejects on misconfiguration", async () => {
		const bad = createVerifier({ baseUrl: fake.issuer });
		const req = new Request(RESOURCE);
		let pending: Promise<unknown> | undefined;
		expect(() => {
			pending = authenticate(bad, req);
		}).not.toThrow();
		await expect(pending).rejects.toThrow(OAuthConfigError);
	});

	type Send = (headers: Record<string, string>) => Promise<Response>;
	it.each<[string, (m: McpAuth) => Promise<Send>]>([
		[
			"nodeMcpBearerAuth",
			async (m) => {
				const mw = nodeMcpBearerAuth(m);
				const url = await listen((req, res) =>
					mw(req, res, () => res.end("ok")),
				);
				return (headers) => fetch(url, { headers });
			},
		],
		[
			"expressMcpBearerAuth",
			async (m) => {
				const app = express();
				app.get(
					"/",
					expressMcpBearerAuth(m),
					(_req, res) => void res.send("ok"),
				);
				const url = await listen(app);
				return (headers) => fetch(url, { headers });
			},
		],
		[
			"honoMcpBearerAuth",
			async (m) => {
				const app = new Hono();
				app.get("/", honoMcpBearerAuth(m), (c) => c.text("ok"));
				return async (headers) =>
					app.request("http://api.test/", { headers });
			},
		],
		[
			"withMcpAuth",
			async (m) => {
				const GET = withMcpAuth(m, () => new Response("ok"));
				return async (headers) =>
					GET(new Request(RESOURCE, { headers }), undefined);
			},
		],
	])("%s builds the guard once for many requests", async (_name, make) => {
		const m = mcp();
		const requireBearerAuth = vi.fn(m.requireBearerAuth);
		const send = await make({ ...m, requireBearerAuth });
		for (let i = 0; i < 2; i++) {
			expect((await send(await bearer())).status).toBe(200);
		}
		expect(requireBearerAuth).toHaveBeenCalledTimes(1);
	});
});

describe("real SDK transport", () => {
	it("hands req.auth to tools as extra.authInfo", async () => {
		const m = mcp();
		const app = express();
		app.use(expressMcp(m));
		app.use(express.json());
		app.post("/mcp", async (req, res) => {
			const server = new McpServer({ name: "t", version: "1.0.0" });
			server.registerTool("whoami", { description: "who" }, (extra) => {
				const info = (extra as { authInfo?: AuthInfo }).authInfo;
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								clientId: info?.clientId,
								sub: (info?.extra?.claims as { sub?: string })
									?.sub,
							}),
						},
					],
				};
			});
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			});
			res.on("close", () => void transport.close());
			await server.connect(transport);
			await transport.handleRequest(req, res, req.body);
		});
		const url = await listen(app);
		const headers = {
			...(await bearer()),
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		};
		const rpc = async (body: object) =>
			(
				await fetch(`${url}/mcp`, {
					method: "POST",
					headers,
					body: JSON.stringify({ jsonrpc: "2.0", ...body }),
				})
			).json();

		const init = await rpc({
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "c", version: "1.0.0" },
			},
		});
		expect(init.result.serverInfo.name).toBe("t");
		const call = await rpc({
			id: 2,
			method: "tools/call",
			params: { name: "whoami", arguments: {} },
		});
		const seen = JSON.parse(call.result.content[0].text);
		expect(seen.sub).toBe("user-1");
		expect(typeof seen.clientId).toBe("string");
	});
});

describe("next adapter", () => {
	it("withMcpAuth maps 401 / 200", async () => {
		const POST = withMcpAuth(mcp(), (_req, auth) =>
			Response.json({ sub: auth.sub }),
		);
		expect(
			(await POST(new Request(RESOURCE, { method: "POST" }), undefined))
				.status,
		).toBe(401);
		const ok = await POST(
			new Request(RESOURCE, { method: "POST", headers: await bearer() }),
			undefined,
		);
		expect(await ok.json()).toEqual({ sub: "user-1" });
	});

	it("createMetadataHandlers serves GET and OPTIONS", async () => {
		const { GET, OPTIONS } = createMetadataHandlers(mcp());
		expect((await GET(new Request(`http://api.test${META}`))).status).toBe(
			200,
		);
		expect(
			OPTIONS(
				new Request(`http://api.test${META}`, { method: "OPTIONS" }),
			).status,
		).toBe(204);
	});
});

// A protected handler must never run without a token, for every request the framework's router
// would send to it. Raw paths are sent over a socket because fetch() normalizes some of them.
describe("path variants cannot bypass the guard", () => {
	const VARIANTS = [
		"/mcp",
		"/mcp/",
		"/mcp//",
		"/MCP",
		"/Mcp/",
		"/%6Dcp",
		"/%6dCP/",
		"/mcp?x=1",
		"//mcp",
	];
	const METHODS = ["POST", "GET", "DELETE", "PUT", "PATCH", "HEAD"];

	async function raw(
		base: string,
		method: string,
		path: string,
		headers: Record<string, string> = {},
	): Promise<number> {
		const { port } = new URL(base);
		const { connect } = await import("node:net");
		return new Promise((resolve, reject) => {
			const socket = connect(Number(port), "127.0.0.1", () => {
				const extra = Object.entries(headers)
					.map(([k, v]) => `${k}: ${v}\r\n`)
					.join("");
				socket.write(
					`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`,
				);
			});
			let data = "";
			socket.on("data", (d) => {
				data += d;
			});
			socket.on("error", reject);
			socket.on("close", () =>
				resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1])),
			);
		});
	}

	async function expectGuarded(base: string, reached: string[]) {
		const unguarded: string[] = [];
		for (const path of VARIANTS) {
			for (const method of METHODS) {
				const status = await raw(base, method, path);
				if (status !== 401)
					unguarded.push(`${method} ${path} -> ${status}`);
			}
		}
		expect(unguarded).toEqual([]);
		expect(reached).toEqual([]);
		const ok = await raw(base, "POST", "/mcp", await bearer());
		expect(ok).toBe(200);
		expect(reached).toEqual(["POST"]);
	}

	it("express with expressMcp", async () => {
		const reached: string[] = [];
		const app = express();
		app.use(expressMcp(mcp()));
		app.use(express.json());
		app.all("/mcp", (req, res) => {
			reached.push(req.method);
			res.json({ ok: true });
		});
		await expectGuarded(await listen(app), reached);
	});

	it("express with expressMcp and a custom path", async () => {
		const reached: string[] = [];
		const app = express();
		app.use(expressMcp(mcp(), { path: "/mcp" }));
		app.all("/mcp", (req, res) => {
			reached.push(req.method);
			res.json({ ok: true });
		});
		await expectGuarded(await listen(app), reached);
	});

	it("node:http", async () => {
		const reached: string[] = [];
		const mw = nodeMcp(mcp());
		const base = await listen((req, res) =>
			mw(req, res, () => {
				reached.push(req.method ?? "");
				res.end("ok");
			}),
		);
		const unguarded: string[] = [];
		for (const path of VARIANTS) {
			for (const method of METHODS) {
				const status = await raw(base, method, path);
				if (status !== 401)
					unguarded.push(`${method} ${path} -> ${status}`);
			}
		}
		expect(unguarded).toEqual([]);
		expect(reached).toEqual([]);
	});

	it("hono with honoMcp", async () => {
		const reached: string[] = [];
		const app = new Hono();
		app.use(honoMcp(mcp()));
		app.all("/mcp", (c) => {
			reached.push(c.req.method);
			return c.json({ ok: true });
		});
		await expectGuarded(
			await listen(async (req, res) => {
				const url = `http://127.0.0.1${req.url}`;
				const response = await app.fetch(
					new Request(url, {
						method: req.method,
						headers: req.headers as Record<string, string>,
					}),
				);
				res.statusCode = response.status;
				res.end(await response.text());
			}),
			reached,
		);
	});

	it("hono with a route-level honoMcp on strict and non-strict apps", async () => {
		for (const strict of [true, false]) {
			const reached: string[] = [];
			const app = new Hono({ strict });
			app.use(honoMcp(mcp()));
			app.all("/mcp", (c) => {
				reached.push(c.req.method);
				return c.json({ ok: true });
			});
			const unguarded: string[] = [];
			for (const path of ["/%6Dcp", "/mcp/", "/MCP"]) {
				const res = await app.request(path, { method: "POST" });
				if (res.status !== 401)
					unguarded.push(`strict=${strict} ${path} -> ${res.status}`);
			}
			expect(unguarded).toEqual([]);
			expect(reached).toEqual([]);
		}
	});

	it("OPTIONS on the MCP path stays unauthenticated", async () => {
		const app = new Hono();
		app.use(honoMcp(mcp()));
		app.options("/mcp", (c) => c.body(null, 204));
		expect((await app.request("/mcp", { method: "OPTIONS" })).status).toBe(
			204,
		);
	});
});
