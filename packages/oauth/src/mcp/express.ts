/**
 * `@neon/oauth/mcp/express` — Express middleware that guards an MCP server and serves its
 * protected-resource metadata. Express is imported for types only; the app provides it at runtime.
 *
 * @module
 */
import type { Request, RequestHandler } from "express";

import type { BearerAuthOptions } from "../verify/bearer";
import type { AuthResult } from "../verify/verifier";
import type { NodeMcpOptions } from "./node";
import { nodeMcp, nodeMcpBearerAuth } from "./node";
import type { McpAuth } from "./resource-server";

/** An Express request that has passed {@link expressMcp} or {@link expressMcpBearerAuth}: `auth` is the verified token. */
export type AuthedRequest = Request & { auth: AuthResult };

/**
 * Express middleware that requires a valid bearer token on one route of an MCP server. On success
 * it sets `req.auth` (the verified {@link AuthResult}) and calls `next()`.
 *
 * Otherwise it responds 401 or 403 with a challenge carrying `resource_metadata`, or 503 when the authorization server is unavailable (500 on an unexpected failure). It does not
 * serve the metadata routes: use {@link expressMcp} for the whole endpoint.
 *
 * @param auth The result of `createMcpAuth()`.
 * @param opts Required scopes and `onError`.
 * @returns Middleware; read the result as `(req as AuthedRequest).auth`.
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
 * requires a valid bearer token on POST, GET and DELETE (the Streamable HTTP methods) at the MCP
 * path, and calls `next()` for every other request. A missing or invalid token gets a 401 or 403 with a challenge carrying `resource_metadata`, or a 503 when the authorization server is unavailable (500 on an unexpected failure). For authenticated requests `req.auth` is the
 * verified {@link AuthResult}.
 *
 * The guard reads headers only, so it works before or after a body parser. The SDK transport
 * reads the request stream unless you pass the parsed body as the third argument of `handleRequest`.
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
 * import { expressMcp, type AuthedRequest } from "@neon/oauth/mcp/express";
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
 *   Object.assign(req, { auth: auth.toAuthInfo((req as AuthedRequest).auth) });
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
