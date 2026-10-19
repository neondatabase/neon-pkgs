/**
 * `@neon/oauth/mcp/hono` — Hono adapters for MCP servers. Hono is imported for types only; it
 * is needed at runtime by the app.
 *
 * @module
 */
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Hono, MiddlewareHandler } from "hono";

import { authenticateWith } from "../verify/authenticate";
import type { BearerAuthOptions } from "../verify/bearer";
import type { AuthResult } from "../verify/verifier";
import type { McpResourceServer } from "./resource-server";
import { MCP_METHODS, mcpPath, routeMcpMetadata } from "./resource-server";

/** Context variables set by the MCP middleware. Use as `new Hono<McpAuthVariables>()` to read them in handlers. */
export type McpAuthVariables = {
	Variables: {
		auth: AuthResult;
		/** `auth` mapped for the MCP SDK transport: `transport.handleRequest(req, { authInfo })`. */
		authInfo: AuthInfo;
	};
};

/**
 * Hono middleware that requires a valid bearer token for one route of an MCP server. On success it
 * sets `c.get('auth')` (the verified `AuthResult`) and `c.get('authInfo')` (the MCP SDK's
 * `AuthInfo`); otherwise it responds 401/403/503 with a challenge carrying `resource_metadata`.
 * Used as route middleware, `app.post('/mcp', honoMcpBearerAuth(auth), handler)`, the handler's
 * context is typed automatically. It does not serve the metadata routes: use `honoMcp` for the
 * whole MCP endpoint, or this together with `honoProtectedResourceMetadata` for per-route control.
 *
 * @param mcp The result of `createMcpAuth()`.
 */
export function honoMcpBearerAuth(
	mcp: McpResourceServer,
	opts: BearerAuthOptions = {},
): MiddlewareHandler<McpAuthVariables> {
	return async (c, next) => {
		const outcome = await authenticateWith(mcp, c.req.raw, opts);
		if (!outcome.ok) return outcome.response;
		c.set("auth", outcome.auth);
		c.set("authInfo", mcp.toAuthInfo(outcome.auth));
		await next();
	};
}

/**
 * Registers GET and OPTIONS routes on `app` for the RFC 9728 protected-resource metadata
 * (path-inserted and bare) with its CORS preflight, unauthenticated by design. Use it together with
 * `honoMcpBearerAuth`; `honoMcp` already includes it.
 *
 * @param mcp The result of `createMcpAuth()`.
 */
export function honoProtectedResourceMetadata(
	app: Hono,
	mcp: McpResourceServer,
): void {
	for (const path of mcp.metadataPaths) {
		app.on(
			["GET", "OPTIONS"],
			path,
			(c) => routeMcpMetadata(mcp, c.req.raw) as Response,
		);
	}
}

/** Options for `honoMcp`: the bearer options, plus the endpoint path. */
export interface HonoMcpOptions extends BearerAuthOptions {
	/** MCP endpoint path. Defaults to the path of `resource`. */
	path?: string;
}

/**
 * Hono middleware that protects an MCP endpoint in one call, `app.use(honoMcp(auth))`. It does
 * three things: it serves the RFC 9728 protected-resource metadata and its CORS preflight
 * (unauthenticated), it requires a valid bearer token on POST/GET/DELETE (the Streamable HTTP
 * methods) at the MCP path (401/403/503 are answered for you), and it passes every other request
 * through. For authenticated requests it sets `c.get('auth')` (the verified `AuthResult`) and
 * `c.get('authInfo')` (the MCP SDK's `AuthInfo`, for `transport.handleRequest(req, { authInfo })`).
 * Create the app as `new Hono<McpAuthVariables>()` so handlers see both typed.
 *
 * Mount it before the MCP route. Use `honoMcpBearerAuth` instead to guard individual routes.
 *
 * @param mcp The result of `createMcpAuth()`.
 *
 * @example
 * ```ts
 * const auth = createMcpAuth({ baseUrl, resource: "https://mcp.example.com/mcp" });
 * const app = new Hono<McpAuthVariables>();
 * app.use(honoMcp(auth));
 * app.post("/mcp", (c) => transport.handleRequest(c.req.raw, { authInfo: c.get("authInfo") }));
 * ```
 */
export function honoMcp(
	mcp: McpResourceServer,
	opts: HonoMcpOptions = {},
): MiddlewareHandler<McpAuthVariables> {
	const { path, ...bearer } = opts;
	const target = mcpPath(mcp, path);
	const guard = honoMcpBearerAuth(mcp, bearer);
	return async (c, next) => {
		const metadata = routeMcpMetadata(mcp, c.req.raw);
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
