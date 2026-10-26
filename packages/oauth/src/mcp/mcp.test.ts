import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOAuth } from "../index";
import type { FakeAuthServer } from "../testing/fake-auth-server";
import { startFakeAuthServer } from "../testing/fake-auth-server";
import {
	honoMcp,
	honoMcpBearerAuth,
	honoProtectedResourceMetadata,
	type McpAuthVariables,
} from "./hono";
import {
	AuthServerUnavailableError,
	createMcpAuth,
	InvalidTokenError,
	routeMcpMetadata,
	toAuthInfo,
} from "./index";

const RESOURCE = "http://api.test/mcp";
const META_PATH = "/.well-known/oauth-protected-resource/mcp";

let auth: FakeAuthServer;
beforeEach(async () => {
	auth = await startFakeAuthServer();
});
afterEach(() => auth.close());

const make = () =>
	createOAuth({ baseUrl: auth.issuer }).mcp({ resource: RESOURCE });

describe("oauth.mcp", () => {
	it("uses the resource as audience and verifies tokens against it", async () => {
		const mcp = make();
		expect(mcp.resource).toBe(RESOURCE);
		await expect(
			mcp.verifyAccessToken(await auth.sign()),
		).resolves.toMatchObject({ ok: true, auth: { sub: "user-1" } });
	});

	it("points resource_metadata at the path-inserted RFC 9728 URL", async () => {
		const res = (await make().requireBearerAuth()(
			new Request(RESOURCE),
		)) as Response;
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBe(
			`Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="http://api.test${META_PATH}"`,
		);
	});

	it("serves metadata with the resource and the configured issuer", () => {
		expect(make().protectedResourceMetadata()).toEqual({
			resource: RESOURCE,
			authorization_servers: [auth.issuer],
		});
	});
});

describe("handleMetadataRequest", () => {
	const get = (path: string, method = "GET") =>
		make().handleMetadataRequest(
			new Request(`http://api.test${path}`, { method }),
		);

	it("answers GET on the path-inserted and bare URLs with CORS", async () => {
		for (const path of [
			META_PATH,
			"/.well-known/oauth-protected-resource",
		]) {
			const res = get(path) as Response;
			expect(res.status).toBe(200);
			expect(res.headers.get("access-control-allow-origin")).toBe("*");
			expect(await res.json()).toEqual({
				resource: RESOURCE,
				authorization_servers: [auth.issuer],
			});
		}
	});

	it("answers the CORS preflight", () => {
		const res = get(META_PATH, "OPTIONS") as Response;
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-methods")).toBe(
			"GET, OPTIONS",
		);
		expect(res.headers.get("access-control-allow-headers")).toBe("*");
	});

	it("ignores other paths and methods", () => {
		expect(get("/mcp")).toBeUndefined();
		expect(get(META_PATH, "POST")).toBeUndefined();
	});
});

describe("honoMcp", () => {
	const build = () => {
		const app = new Hono<McpAuthVariables>();
		app.use(honoMcp(make()));
		app.post("/mcp", (c) =>
			c.json({
				sub: c.get("auth").sub,
				clientId: c.get("authInfo").clientId,
			}),
		);
		return app;
	};

	it("mounts metadata routes and guards the MCP path", async () => {
		const app = build();
		expect((await app.request(META_PATH)).status).toBe(200);
		expect(
			(await app.request("/.well-known/oauth-protected-resource")).status,
		).toBe(200);
		expect(
			(await app.request(META_PATH, { method: "OPTIONS" })).status,
		).toBe(204);

		const denied = await app.request("/mcp", { method: "POST" });
		expect(denied.status).toBe(401);
		expect(denied.headers.get("www-authenticate")).toContain(
			`resource_metadata="http://api.test${META_PATH}"`,
		);

		const ok = await app.request("/mcp", {
			method: "POST",
			headers: { authorization: `Bearer ${await auth.sign()}` },
		});
		expect(await ok.json()).toEqual({
			sub: "user-1",
			clientId: "client-1",
		});
	});

	it("passes other paths through to later routes", async () => {
		const app = build();
		app.get("/health", (c) => c.text("up"));
		expect(await (await app.request("/health")).text()).toBe("up");
	});

	it("guards GET and DELETE too, and honours a custom path", async () => {
		const app = new Hono();
		app.use(honoMcp(make(), { path: "/rpc" }));
		expect((await app.request("/rpc", { method: "GET" })).status).toBe(401);
		expect((await app.request("/rpc", { method: "DELETE" })).status).toBe(
			401,
		);
	});

	it("honoMcpBearerAuth guards a route with the mcp server", async () => {
		const app = new Hono();
		app.use("/x", honoMcpBearerAuth(make()));
		app.get("/x", (c) => c.text("ok"));
		expect((await app.request("/x")).status).toBe(401);
		expect(
			(
				await app.request("/x", {
					headers: { authorization: `Bearer ${await auth.sign()}` },
				})
			).status,
		).toBe(200);
	});

	it("honoProtectedResourceMetadata alone leaves the MCP path open", async () => {
		const app = new Hono();
		honoProtectedResourceMetadata(app, make());
		expect((await app.request(META_PATH)).status).toBe(200);
		expect((await app.request("/mcp", { method: "POST" })).status).toBe(
			404,
		);
	});
});

describe("mcp.toAuthInfo", () => {
	it("maps a verified result to the SDK AuthInfo", async () => {
		const verified = await make().verifyAccessToken(await auth.sign());
		if (!verified.ok) throw new Error("expected a valid token");
		const result = verified.auth;
		const info = make().toAuthInfo(result);
		expect(info).toMatchObject({
			token: result.token,
			clientId: "client-1",
			scopes: ["openid", "profile"],
			expiresAt: result.expiresAt,
		});
		expect(info.resource?.href).toBe(RESOURCE);
		expect(info.extra?.claims).toBe(result.claims);
	});
});

describe("@neon/oauth-client/mcp createMcpAuth", () => {
	const viaOAuth = () =>
		createOAuth({ baseUrl: auth.issuer }).mcp({
			resource: RESOURCE,
			scopesSupported: ["read"],
		});
	const viaMcpAuth = () =>
		createMcpAuth({
			baseUrl: auth.issuer,
			resource: RESOURCE,
			scopesSupported: ["read"],
		});
	const dump = async (res: Response | undefined) => ({
		status: res?.status,
		headers: [...(res?.headers ?? [])].sort(),
		body: await res?.text(),
	});

	it("exposes the same server shape", () => {
		const a = viaMcpAuth();
		const b = viaOAuth();
		expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
		expect(a).toMatchObject({
			issuer: b.issuer,
			resource: b.resource,
			resourceMetadataUrl: b.resourceMetadataUrl,
			metadataPaths: b.metadataPaths,
		});
		expect(a.protectedResourceMetadata()).toEqual(
			b.protectedResourceMetadata(),
		);
	});

	it("serves identical metadata and preflight responses", async () => {
		for (const [path, method] of [
			[META_PATH, "GET"],
			["/.well-known/oauth-protected-resource", "GET"],
			[META_PATH, "OPTIONS"],
		] as const) {
			const req = () => new Request(`http://api.test${path}`, { method });
			expect(
				await dump(viaMcpAuth().handleMetadataRequest(req())),
			).toEqual(await dump(viaOAuth().handleMetadataRequest(req())));
		}
	});

	it("issues identical challenges for missing and invalid tokens", async () => {
		const reqs = [
			new Request(RESOURCE),
			new Request(RESOURCE, {
				headers: { authorization: "Bearer nope" },
			}),
		];
		for (const r of reqs) {
			expect(
				await dump(
					(await viaMcpAuth().requireBearerAuth()(
						r.clone(),
					)) as Response,
				),
			).toEqual(
				await dump(
					(await viaOAuth().requireBearerAuth()(
						r.clone(),
					)) as Response,
				),
			);
		}
	});

	it("verifies the same tokens and maps them with toAuthInfo", async () => {
		const mcp = viaMcpAuth();
		const verified = await mcp.verifyAccessToken(await auth.sign());
		if (!verified.ok) throw new Error("expected a valid token");
		const result = verified.auth;
		expect(result).toMatchObject({ sub: "user-1" });
		expect(toAuthInfo(result)).toEqual(mcp.toAuthInfo(result));
		expect(toAuthInfo(result).resource?.href).toBe(RESOURCE);
	});

	it("re-exports the MCP helpers", () => {
		expect(typeof routeMcpMetadata).toBe("function");
		expect(new InvalidTokenError("invalid_token", "x")).toBeInstanceOf(
			Error,
		);
		expect(AuthServerUnavailableError).toBeDefined();
	});
});
