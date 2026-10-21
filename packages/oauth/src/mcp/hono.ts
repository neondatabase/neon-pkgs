/**
 * `@neon/oauth/mcp/hono` — Hono middleware that guards an MCP server and serves its
 * protected-resource metadata. Hono is imported for types only; the app provides it at runtime.
 *
 * @module
 */
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Hono, MiddlewareHandler } from "hono";

import { authenticateWith } from "../verify/authenticate";
import type { BearerAuthOptions } from "../verify/bearer";
import type { AuthResult } from "../verify/verifier";
import type { McpAuth } from "./resource-server";
import { MCP_METHODS, mcpPath, routeMcpMetadata } from "./resource-server";

/** Hono context variables set by {@link honoMcp} and {@link honoMcpBearerAuth}. Create the app as `new Hono<McpAuthVariables>()` to read them in handlers. */
export type McpAuthVariables = {
	Variables: {
		auth: AuthResult;
		/** `auth` as the MCP TypeScript SDK's `AuthInfo`: pass it to `transport.handleRequest(req, { authInfo })`, and tools receive it as `extra.authInfo`. */
		authInfo: AuthInfo;
	};
};

/**
 * Hono middleware that requires a valid bearer token on one route of an MCP server. On success it
 * sets `c.get("auth")` (the verified {@link AuthResult}) and `c.get("authInfo")` (the MCP SDK's
 * `AuthInfo`).
 *
 * Otherwise it sends the guard's error response (401 or 403 with a challenge, 503, or 500; see
 * `BearerGuard`). It does not serve the metadata routes: use {@link honoMcp} for the whole
 * endpoint, or pair this with {@link honoProtectedResourceMetadata} for per-route control. Used as
 * route middleware, the handler's context is typed automatically.
 *
 * @param auth The result of `createMcpAuth()`.
 * @param opts Required scopes and `onError`.
 * @returns Middleware typed with {@link McpAuthVariables}.
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
 * import { createMcpAuth } from "@neon/oauth/mcp";
 * import { honoMcpBearerAuth, honoProtectedResourceMetadata } from "@neon/oauth/mcp/hono";
 *
 * const auth = createMcpAuth({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   resource: "https://mcp.example.com/mcp",
 * });
 * const newServer = () => new McpServer({ name: "demo", version: "1.0.0" });
 *
 * const app = new Hono();
 * honoProtectedResourceMetadata(app, auth);
 * app.post("/mcp", honoMcpBearerAuth(auth, { requiredScopes: ["mcp"] }), async (c) => {
 *   const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
 *   await newServer().connect(transport);
 *   return transport.handleRequest(c.req.raw, { authInfo: c.get("authInfo") });
 * });
 * ```
 */
export function honoMcpBearerAuth(
	auth: McpAuth,
	opts: BearerAuthOptions = {},
): MiddlewareHandler<McpAuthVariables> {
	return async (c, next) => {
		const outcome = await authenticateWith(auth, c.req.raw, opts);
		if (!outcome.ok) return outcome.response;
		c.set("auth", outcome.auth);
		c.set("authInfo", auth.toAuthInfo(outcome.auth));
		await next();
	};
}

/**
 * Registers GET and OPTIONS routes on `app` for the RFC 9728 protected-resource metadata (path-inserted
 * and bare) and its CORS preflight, unauthenticated by design. Pair it with {@link honoMcpBearerAuth};
 * {@link honoMcp} already includes it.
 *
 * @param app The Hono app to register the routes on.
 * @param auth The result of `createMcpAuth()`.
 */
export function honoProtectedResourceMetadata(app: Hono, auth: McpAuth): void {
	for (const path of auth.metadataPaths) {
		app.on(
			["GET", "OPTIONS"],
			path,
			(c) => routeMcpMetadata(auth, c.req.raw) as Response,
		);
	}
}

/** Options for {@link honoMcp}: the bearer options, plus the endpoint path. */
export interface HonoMcpOptions extends BearerAuthOptions {
	/**
	 * MCP endpoint path to guard.
	 *
	 * @defaultValue the path of the server's `resource` URL
	 */
	path?: string;
}

/**
 * Hono middleware that protects an MCP endpoint in one call: `app.use(honoMcp(auth))`.
 *
 * It serves the RFC 9728 protected-resource metadata and its CORS preflight (unauthenticated),
 * requires a valid bearer token on POST, GET and DELETE (the Streamable HTTP methods) at the MCP
 * path, and passes every other request through. A missing or invalid token gets the guard's error
 * response (401 or 403 with a challenge, 503, or 500; see `BearerGuard`). For authenticated
 * requests it sets `c.get("auth")` (the verified {@link AuthResult}) and `c.get("authInfo")` (the
 * MCP SDK's `AuthInfo`; see `McpAuth.toAuthInfo`).
 *
 * Mount it before the MCP route. The example's Web-standard transport needs
 * `@modelcontextprotocol/sdk` 1.25.0 or later.
 *
 * @param auth The result of `createMcpAuth()`.
 * @param opts Required scopes, `onError` and the endpoint `path`. See {@link HonoMcpOptions}.
 * @returns Middleware typed with {@link McpAuthVariables}.
 * @see {@link honoMcpBearerAuth} to guard individual routes instead.
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
 * import { createMcpAuth } from "@neon/oauth/mcp";
 * import { honoMcp, type McpAuthVariables } from "@neon/oauth/mcp/hono";
 *
 * const auth = createMcpAuth({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   resource: "https://mcp.example.com/mcp",
 * });
 * const newServer = () => new McpServer({ name: "demo", version: "1.0.0" });
 *
 * const app = new Hono<McpAuthVariables>();
 * app.use(honoMcp(auth));
 * app.all("/mcp", async (c) => {
 *   const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
 *   await newServer().connect(transport);
 *   return transport.handleRequest(c.req.raw, { authInfo: c.get("authInfo") });
 * });
 * ```
 */
export function honoMcp(
	auth: McpAuth,
	opts: HonoMcpOptions = {},
): MiddlewareHandler<McpAuthVariables> {
	const { path, ...bearer } = opts;
	const target = mcpPath(auth, path);
	const guard = honoMcpBearerAuth(auth, bearer);
	return async (c, next) => {
		const metadata = routeMcpMetadata(auth, c.req.raw);
		if (metadata) return metadata;
		if (
			new URL(c.req.url).pathname === target &&
			(MCP_METHODS as readonly string[]).includes(c.req.method)
		) {
			return guard(c, next);
		}
		return next();
	};
}
