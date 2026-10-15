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
 * Bearer guard for a route served by the MCP server. On success the verified `AuthResult` is at
 * `c.get('auth')` and the SDK's `AuthInfo` at `c.get('authInfo')`. As route middleware
 * (`app.post('/mcp', honoMcpBearerAuth(mcp), handler)`) the handler's context is typed automatically.
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

/** Serves the RFC 9728 metadata (path-inserted and bare) plus its CORS preflight. Unauthenticated by design. */
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

export interface HonoMcpOptions extends BearerAuthOptions {
	/** MCP endpoint path. Defaults to the path of `resource`. */
	path?: string;
}

/**
 * Protects an MCP endpoint with one `app.use(honoMcp(mcp))`: serves the metadata routes and guards
 * POST/GET/DELETE on the MCP path (the Streamable HTTP methods), passing everything else through.
 * Create the app as `new Hono<McpAuthVariables>()` so handlers see `c.get('auth')` and `c.get('authInfo')`.
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
