/**
 * `@neon/oauth/mcp/express` — Express middleware that guards an MCP server and serves its
 * protected-resource metadata. Express is imported for types only; the app provides it at runtime.
 *
 * **Stability: beta.** Minor versions may include breaking changes.
 *
 * @module
 */
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Request, RequestHandler } from "express";

import type { BearerAuthOptions } from "../verify/bearer";
import type { AuthResult } from "../verify/verifier";
import type { McpAuth } from "./mcp-auth";
import type { NodeMcpOptions } from "./node";
import { nodeMcp, nodeMcpBearerAuth } from "./node";

export type { NodeMcpOptions };

/**
 * An Express request that has passed {@link expressMcp} or {@link expressMcpBearerAuth}: `auth` is
 * the verified token as the MCP SDK's `AuthInfo` (what its transport reads), `authResult` the full
 * {@link AuthResult}.
 */
export type AuthedRequest = Request & {
	auth: AuthInfo;
	authResult: AuthResult;
};

/**
 * Express middleware that requires a valid bearer token on one route of an MCP server. On success
 * it sets `req.auth` (the MCP SDK's `AuthInfo`) and `req.authResult` (the verified
 * {@link AuthResult}) and calls `next()`.
 *
 * Otherwise it sends the guard's error response (401 or 403 with a challenge, 503, or 500; see
 * `BearerGuard`). It does not serve the metadata routes: use {@link expressMcp} for the whole
 * endpoint.
 *
 * @param auth The result of `createMcpAuth()`.
 * @param opts Required scopes and `onError`.
 * @returns Middleware; read the result as `(req as AuthedRequest).authResult`.
 */
export function expressMcpBearerAuth(
	auth: McpAuth,
	opts?: BearerAuthOptions,
): RequestHandler {
	return nodeMcpBearerAuth(auth, opts);
}

/**
 * Express middleware that protects an MCP endpoint in one call: `app.use(expressMcp(auth))`.
 *
 * It serves the RFC 9728 protected-resource metadata and its CORS preflight (unauthenticated),
 * requires a valid bearer token on every method except `OPTIONS` at the MCP path (matched
 * ignoring case and a trailing slash, with percent-escapes decoded), and calls `next()` for every other request. A missing or invalid token gets the guard's
 * error response (401 or 403 with a challenge, 503, or 500; see `BearerGuard`). For authenticated
 * requests `req.auth` is the MCP TypeScript SDK's `AuthInfo`, which its Node transport reads in
 * `handleRequest` and hands to tools as `extra.authInfo`, and `req.authResult` is the verified
 * {@link AuthResult}.
 *
 * The guard reads headers only, so it works before or after a body parser. The SDK transport
 * reads the request stream unless you pass the parsed body as the third argument of `handleRequest`.
 *
 * Mount the MCP handler with a method route such as `app.post("/mcp", ...)`. A prefix mount such as
 * `app.use("/mcp", handler)` also receives `/mcp/<anything>`, which this guard does not cover; put
 * {@link expressMcpBearerAuth} in front of such a handler instead.
 *
 * @param auth The result of `createMcpAuth()`.
 * @param opts Required scopes, `onError` and the endpoint `path`. See {@link NodeMcpOptions}.
 * @returns Express middleware.
 * @see {@link expressMcpBearerAuth} to guard individual routes instead.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
 * import { createMcpAuth } from "@neon/oauth/mcp";
 * import { expressMcp } from "@neon/oauth/mcp/express";
 *
 * const auth = createMcpAuth({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   resource: "https://mcp.example.com/mcp",
 * });
 * const newServer = () => new McpServer({ name: "demo", version: "1.0.0" });
 *
 * const app = express();
 * app.use(expressMcp(auth));
 * app.use(express.json());
 * app.post("/mcp", async (req, res) => {
 *   const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
 *   await newServer().connect(transport);
 *   await transport.handleRequest(req, res, req.body);
 * });
 * ```
 */
export function expressMcp(
	auth: McpAuth,
	opts?: NodeMcpOptions,
): RequestHandler {
	return nodeMcp(auth, opts);
}
