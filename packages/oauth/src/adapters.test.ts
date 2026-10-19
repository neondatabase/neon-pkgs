// Contract tests for the OAuth adapter contract, then one thin smoke test per adapter proving it
// maps 401 / 200 / client routes through the contract.

import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	authenticate,
	clientMetadataResponse,
	routeClientMetadata,
	routeOAuthClient,
} from "./adapter";
import { createClientMetadataDocument } from "./client/metadata-document";
import type { AuthedRequest } from "./express";
import {
	expressBearerAuth,
	expressClientMetadata,
	expressOAuthClient,
} from "./express";
import { honoBearerAuth, honoClientMetadata, honoOAuthClient } from "./hono";
import { createOAuth } from "./index";
import {
	createClientMetadataHandlers,
	createRouteHandlers,
	withAuth,
} from "./next";
import { nodeBearerAuth, nodeClientMetadata, toNodeHandler } from "./node";
import type { FakeAuthServer } from "./testing/fake-auth-server";
import { startFakeAuthServer } from "./testing/fake-auth-server";
import { createVerifier } from "./verify";

const API = "http://api.test/api";

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

const oauth = (redirectUri = "http://api.test/auth/callback") =>
	createOAuth({
		baseUrl: fake.issuer,
		clientId: "c1",
		redirectUri,
		cookies: { secret: "x".repeat(32) },
	});
const apiBearer = async () => ({
	authorization: `Bearer ${await fake.sign({}, { aud: API })}`,
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
			oauth(),
			new Request(API, { headers: await apiBearer() }),
			{ audience: API },
		);
		expect(out).toMatchObject({ ok: true, auth: { sub: "user-1" } });
	});

	it("authenticate returns { ok: false, response } with the challenge", async () => {
		const out = await authenticate(oauth(), new Request(API), {
			audience: API,
		});
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.response.status).toBe(401);
		expect(out.response.headers.get("www-authenticate")).toContain(
			'error="invalid_token"',
		);
	});

	it("authenticate enforces scopes", async () => {
		const denied = await authenticate(
			oauth(),
			new Request(API, { headers: await apiBearer() }),
			{ audience: API, requiredScopes: ["admin"] },
		);
		expect(!denied.ok && denied.response.status).toBe(403);
	});

	it("routeOAuthClient routes GET under the redirectUri prefix and ignores the rest", async () => {
		const { client } = oauth();
		const logout = await routeOAuthClient(
			client,
			new Request("http://api.test/auth/logout?returnTo=/x"),
		);
		expect(logout?.status).toBe(302);
		expect(logout?.headers.get("location")).toBe("/x");
		expect(
			await routeOAuthClient(
				client,
				new Request("http://api.test/logout"),
			),
		).toBeUndefined();
		expect(
			await routeOAuthClient(
				client,
				new Request("http://api.test/auth/other"),
			),
		).toBeUndefined();
		expect(
			await routeOAuthClient(
				client,
				new Request("http://api.test/auth/logout", { method: "POST" }),
			),
		).toBeUndefined();
	});

	it("routeOAuthClient derives the prefix from redirectUri, including the root", async () => {
		const nested = oauth("http://api.test/api/auth/callback").client;
		expect(
			(
				await routeOAuthClient(
					nested,
					new Request("http://api.test/api/auth/logout"),
				)
			)?.status,
		).toBe(302);
		expect(
			await routeOAuthClient(
				nested,
				new Request("http://api.test/auth/logout"),
			),
		).toBeUndefined();
		const root = oauth("http://api.test/callback").client;
		expect(
			(
				await routeOAuthClient(
					root,
					new Request("http://api.test/logout"),
				)
			)?.status,
		).toBe(302);
	});

	it("accepts an explicit basePath that matches redirectUri, with or without a trailing slash", async () => {
		const { client } = oauth("http://api.test/api/auth/callback");
		for (const basePath of ["/api/auth", "/api/auth/"]) {
			expect(
				(
					await routeOAuthClient(
						client,
						new Request("http://api.test/api/auth/logout"),
						{
							basePath,
						},
					)
				)?.status,
			).toBe(302);
		}
	});

	it("throws naming both when basePath disagrees with redirectUri", async () => {
		const { client } = oauth("http://api.test/api/auth/callback");
		await expect(
			routeOAuthClient(
				client,
				new Request("http://api.test/auth/logout"),
				{
					basePath: "/auth",
				},
			),
		).rejects.toThrow(
			/basePath "\/auth".*redirectUri "http:\/\/api\.test\/api\/auth\/callback"/,
		);
	});

	it("throws when redirectUri does not end in /callback", async () => {
		const { client } = oauth("http://api.test/auth/done");
		await expect(
			routeOAuthClient(
				client,
				new Request("http://api.test/auth/logout"),
			),
		).rejects.toThrow(/must end in "\/callback"/);
	});
});

describe("adapter creation", () => {
	it("fails when basePath disagrees with redirectUri instead of on the first request", () => {
		const { client } = oauth();
		expect(() => honoOAuthClient(client, { basePath: "/other" })).toThrow(
			/basePath/,
		);
		expect(() =>
			expressOAuthClient(client, { basePath: "/other" }),
		).toThrow(/basePath/);
		expect(() =>
			createRouteHandlers(client, { basePath: "/other" }),
		).toThrow(/basePath/);
	});
});

describe("hono adapter", () => {
	it("maps 401 / 200 / client routes", async () => {
		const o = oauth();
		const app = new Hono();
		app.use(honoOAuthClient(o.client));
		app.get("/api", honoBearerAuth(o, { audience: API }), (c) =>
			c.text("ok"),
		);
		expect((await app.request("/auth/logout")).status).toBe(302);
		expect((await app.request("/api")).status).toBe(401);
		expect(
			(await app.request("/api", { headers: await apiBearer() })).status,
		).toBe(200);
	});
});

describe("node adapter", () => {
	it("toNodeHandler serves a fetch handler, keeping repeated Set-Cookie separate", async () => {
		const url = await listen(
			toNodeHandler(() => {
				const h = new Headers();
				h.append("set-cookie", "a=1");
				h.append("set-cookie", "b=2");
				return new Response("hi", { headers: h });
			}),
		);
		const res = await fetch(url);
		expect(await res.text()).toBe("hi");
		expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
	});

	it("toNodeHandler streams the body instead of buffering it", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const enc = new TextEncoder();
		const url = await listen(
			toNodeHandler(
				() =>
					new Response(
						new ReadableStream({
							async start(controller) {
								controller.enqueue(enc.encode("first;"));
								await gate;
								controller.enqueue(enc.encode("second"));
								controller.close();
							},
						}),
					),
			),
		);
		const res = await fetch(url);
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe("first;");
		release();
		let rest = "";
		for (let r = await reader.read(); !r.done; r = await reader.read())
			rest += new TextDecoder().decode(r.value);
		expect(rest).toBe("second");
	}, 3000);

	it("nodeBearerAuth maps 401 / 200", async () => {
		const api = nodeBearerAuth(oauth(), { audience: API });
		const url = await listen((req, res) =>
			api(req, res, () => res.end("api ok")),
		);
		expect((await fetch(`${url}/api`)).status).toBe(401);
		expect(
			await (
				await fetch(`${url}/api`, { headers: await apiBearer() })
			).text(),
		).toBe("api ok");
	});
});

describe("express adapter", () => {
	it("maps 401 / 200 (req.auth) / client routes", async () => {
		const o = oauth();
		const app = express();
		app.use(expressOAuthClient(o.client));
		app.get(
			"/api",
			expressBearerAuth(o, { audience: API }),
			(req, res) =>
				void res.json({ sub: (req as AuthedRequest).auth.sub }),
		);
		const url = await listen(app);
		expect(
			(await fetch(`${url}/auth/logout`, { redirect: "manual" })).status,
		).toBe(302);
		expect((await fetch(`${url}/api`)).status).toBe(401);
		expect(
			await (
				await fetch(`${url}/api`, { headers: await apiBearer() })
			).json(),
		).toEqual({ sub: "user-1" });
	});
});

describe("next adapter", () => {
	it("withAuth maps 401 / 200 and passes route context", async () => {
		const GET = withAuth(
			oauth(),
			(_req, auth, ctx: { id: string }) =>
				Response.json({ sub: auth.sub, id: ctx.id }),
			{ audience: API },
		);
		expect((await GET(new Request(API), { id: "1" })).status).toBe(401);
		const ok = await GET(new Request(API, { headers: await apiBearer() }), {
			id: "1",
		});
		expect(await ok.json()).toEqual({ sub: "user-1", id: "1" });
	});

	it("createRouteHandlers serves the routes under the redirectUri prefix and 404s otherwise", async () => {
		const { GET } = createRouteHandlers(
			oauth("http://api.test/api/auth/callback").client,
		);
		expect(
			(await GET(new Request("http://api.test/api/auth/logout"))).status,
		).toBe(302);
		expect(
			(await GET(new Request("http://api.test/api/auth/nope"))).status,
		).toBe(404);
	});
});

describe("verifier-only source (createVerifier from @neon/oauth/verify)", () => {
	const verifier = () => createVerifier({ baseUrl: fake.issuer });

	it("works with authenticate and every guard", async () => {
		const v = verifier();
		const headers = await apiBearer();
		const request = () => new Request(API, { headers });

		const out = await authenticate(v, request(), { audience: API });
		expect(out).toMatchObject({ ok: true, auth: { sub: "user-1" } });
		const denied = await authenticate(v, new Request(API), {
			audience: API,
		});
		expect(!denied.ok && denied.response.status).toBe(401);

		const app = new Hono();
		app.get("/api", honoBearerAuth(v, { audience: API }), (c) =>
			c.text("ok"),
		);
		expect((await app.request("/api")).status).toBe(401);
		expect((await app.request("/api", { headers })).status).toBe(200);

		const GET = withAuth(v, (_req, auth) => Response.json(auth.sub), {
			audience: API,
		});
		expect((await GET(new Request(API), undefined)).status).toBe(401);
		expect((await GET(request(), undefined)).status).toBe(200);

		const nodeUrl = await listen((req, res) =>
			nodeBearerAuth(v, { audience: API })(req, res, () => res.end("ok")),
		);
		expect((await fetch(nodeUrl)).status).toBe(401);
		expect((await fetch(nodeUrl, { headers })).status).toBe(200);

		const expressApp = express();
		expressApp.get(
			"/api",
			expressBearerAuth(v, { audience: API }),
			(_req, res) => void res.send("ok"),
		);
		const expressUrl = await listen(expressApp);
		expect((await fetch(`${expressUrl}/api`)).status).toBe(401);
		expect((await fetch(`${expressUrl}/api`, { headers })).status).toBe(
			200,
		);
	});

	it("takes the audience from the resource given to createVerifier", async () => {
		const v = createVerifier({ baseUrl: fake.issuer, resource: API });
		const out = await authenticate(
			v,
			new Request(API, { headers: await apiBearer() }),
		);
		expect(out.ok).toBe(true);
	});

	it("throws OAuthConfigError without an audience or resource", () => {
		expect(() => verifier().requireBearerAuth()).toThrow(
			/audience.*resource/,
		);
	});
});

describe("client metadata document routes", () => {
	const CLIENT_ID = "https://app.example.com/oauth/client.json";
	const doc = createClientMetadataDocument({
		clientId: CLIENT_ID,
		clientName: "Reports",
		redirectUris: ["https://app.example.com/api/auth/callback"],
	});

	async function expectServed(res: Response) {
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/^application\/json/);
		expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
		expect(await res.json()).toEqual(doc);
	}

	it("clientMetadataResponse is JSON with a cache lifetime", async () => {
		await expectServed(clientMetadataResponse(doc));
	});

	it("routeClientMetadata answers GET and HEAD on the client_id path only", async () => {
		await expectServed(
			routeClientMetadata(doc, new Request(CLIENT_ID)) as Response,
		);
		const head = routeClientMetadata(
			doc,
			new Request(CLIENT_ID, { method: "HEAD" }),
		) as Response;
		expect(head.status).toBe(200);
		expect(
			routeClientMetadata(
				doc,
				new Request("https://app.example.com/other"),
			),
		).toBeUndefined();
		expect(
			routeClientMetadata(
				doc,
				new Request(CLIENT_ID, { method: "POST" }),
			),
		).toBeUndefined();
	});

	it("hono serves the document and falls through elsewhere", async () => {
		const app = new Hono();
		app.use(honoClientMetadata(doc));
		app.get("/other", (c) => c.text("other"));
		await expectServed(await app.request(CLIENT_ID));
		expect(await (await app.request("/other")).text()).toBe("other");
	});

	it("next serves the document from the route that mounts it", async () => {
		const { GET } = createClientMetadataHandlers(doc);
		await expectServed(await GET(new Request("http://x.test/anything")));
	});

	it("node and express serve the document and fall through elsewhere", async () => {
		const nodeUrl = await listen((req, res) =>
			nodeClientMetadata(doc)(req, res, () => res.end("next")),
		);
		await expectServed(await fetch(`${nodeUrl}/oauth/client.json`));
		expect(await (await fetch(`${nodeUrl}/other`)).text()).toBe("next");

		const app = express();
		app.use(expressClientMetadata(doc));
		app.get("/other", (_req, res) => void res.send("other"));
		const expressUrl = await listen(app);
		await expectServed(await fetch(`${expressUrl}/oauth/client.json`));
		expect(await (await fetch(`${expressUrl}/other`)).text()).toBe("other");
	});
});
