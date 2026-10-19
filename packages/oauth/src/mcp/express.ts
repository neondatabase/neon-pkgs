/**
 * `@neon/oauth/mcp/express` — Express adapters for MCP servers. Express is imported for types
 * only; it is needed at runtime by the app.
 *
 * @module
 */
import type { Request, RequestHandler } from "express";

import type { BearerAuthOptions } from "../verify/bearer";
import type { AuthResult } from "../verify/verifier";
import type { NodeMcpOptions } from "./node";
import { nodeMcp, nodeMcpBearerAuth } from "./node";
import type { McpResourceServer } from "./resource-server";

/** A request that has passed `expressMcp` / `expressMcpBearerAuth`. */
export type AuthedRequest = Request & { auth: AuthResult };

/**
 * Express middleware that requires a valid bearer token for one route of an MCP server. On
 * success it sets `req.auth` (the verified `AuthResult`) and calls `next()`; otherwise it responds
 * 401/403/503 with a challenge carrying `resource_metadata`. It does not serve the metadata routes:
 * use `expressMcp` for the whole MCP endpoint.
 *
 * @param mcp The result of `createMcpAuth()`.
 */
export function expressMcpBearerAuth(
	mcp: McpResourceServer,
	opts?: BearerAuthOptions,
): RequestHandler {
	return nodeMcpBearerAuth(mcp, opts);
}

/**
 * Express middleware that protects an MCP endpoint in one call, `app.use(expressMcp(auth))`. It
 * serves the RFC 9728 protected-resource metadata and its CORS preflight (unauthenticated),
 * requires a valid bearer token on POST/GET/DELETE (the Streamable HTTP methods) at the MCP path
 * (401/403/503 are answered for you), and calls `next()` for every other request. For
 * authenticated requests `req.auth` is the verified `AuthResult`; pass
 * `auth.toAuthInfo(req.auth)` to the SDK transport as `authInfo`.
 *
 * Mount it before `express.json()`, or the transport cannot read the request body. Register the
 * MCP handler after it and read `(req as AuthedRequest).auth`.
 *
 * @param mcp The result of `createMcpAuth()`.
 *
 * @example
 * ```ts
 * const auth = createMcpAuth({ baseUrl, resource: "https://mcp.example.com/mcp" });
 * app.use(expressMcp(auth));
 * app.post("/mcp", (req, res) =>
 *   transport.handleRequest(req, res, { authInfo: auth.toAuthInfo((req as AuthedRequest).auth) }));
 * ```
 */
export function expressMcp(
	mcp: McpResourceServer,
	opts?: NodeMcpOptions,
): RequestHandler {
	return nodeMcp(mcp, opts);
}
