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

/** Bearer guard for any route served by the MCP server. On success the verified `AuthResult` is at `req.auth`. */
export function expressMcpBearerAuth(
	mcp: McpResourceServer,
	opts?: BearerAuthOptions,
): RequestHandler {
	return nodeMcpBearerAuth(mcp, opts);
}

/**
 * Protects an MCP endpoint with one `app.use(...)`: serves the metadata routes and guards POST/GET/DELETE on
 * the MCP path. Register the MCP handler after it and read `(req as AuthedRequest).auth`.
 * Mount it before `express.json()`, or the transport cannot read the request body.
 */
export function expressMcp(
	mcp: McpResourceServer,
	opts?: NodeMcpOptions,
): RequestHandler {
	return nodeMcp(mcp, opts);
}
