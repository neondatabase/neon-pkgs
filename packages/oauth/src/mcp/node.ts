/**
 * `@neon/oauth/mcp/node` — `node:http` middleware that guards an MCP server and serves its
 * protected-resource metadata.
 *
 * @module
 */
import type { IncomingMessage } from "node:http";
import type { NodeMiddleware } from "../internal/node";
import { nodeMiddleware } from "../internal/node";
import { authenticateWith } from "../verify/authenticate";
import type { BearerAuthOptions } from "../verify/bearer";
import type { AuthResult } from "../verify/verifier";
import type { McpAuth } from "./resource-server";
import { MCP_METHODS, mcpPath, routeMcpMetadata } from "./resource-server";

export type { NodeMiddleware };
/** A `node:http` request after {@link nodeMcp} or {@link nodeMcpBearerAuth} has run: `auth` is the verified token. */
export type AuthedIncomingMessage = IncomingMessage & { auth?: AuthResult };

/**
 * `node:http` middleware that requires a valid bearer token on one route of an MCP server. On
 * success it sets `req.auth` (the verified {@link AuthResult}) and calls `next()`.
 *
 * Otherwise it sends the guard's error response (401 or 403 with a challenge, 503, or 500; see
 * `BearerGuard`). It does not serve the metadata routes: use {@link nodeMcp} for the whole
 * endpoint.
 *
 * @param auth The result of `createMcpAuth()`.
 * @param opts Required scopes and `onError`.
 * @returns A `(req, res, next)` middleware; read the result from `req.auth` (see {@link AuthedIncomingMessage}).
 */
export function nodeMcpBearerAuth(
	auth: McpAuth,
	opts: BearerAuthOptions = {},
): NodeMiddleware {
	return nodeMiddleware(async (request, req) => {
		const outcome = await authenticateWith(auth, request, opts);
		if (!outcome.ok) return outcome.response;
		(req as AuthedIncomingMessage).auth = outcome.auth;
		return undefined;
	});
}

/** Options for {@link nodeMcp} and `expressMcp`: the bearer options, plus the endpoint path. */
export interface NodeMcpOptions extends BearerAuthOptions {
	/**
	 * MCP endpoint path to guard.
	 *
	 * @defaultValue the path of the server's `resource` URL
	 */
	path?: string;
}

/**
 * `node:http` middleware (`(req, res, next)`) that protects an MCP endpoint in one call.
 *
 * It serves the RFC 9728 protected-resource metadata and its CORS preflight (unauthenticated),
 * requires a valid bearer token on POST, GET and DELETE (the Streamable HTTP methods) at the MCP
 * path, and calls `next()` for everything else. A missing or invalid token gets the guard's error
 * response (401 or 403 with a challenge, 503, or 500; see `BearerGuard`). For authenticated
 * requests `req.auth` is the verified {@link AuthResult} (see {@link AuthedIncomingMessage}). The
 * SDK's Node transport reads `req.auth` as the MCP TypeScript SDK's `AuthInfo`, so replace it with
 * `auth.toAuthInfo(req.auth)` before `handleRequest`.
 *
 * @param auth The result of `createMcpAuth()`.
 * @param opts Required scopes, `onError` and the endpoint `path`. See {@link NodeMcpOptions}.
 * @returns A `(req, res, next)` middleware.
 * @see {@link nodeMcpBearerAuth} to guard individual routes instead.
 *
 * @example
 * ```ts
 * import { createServer } from "node:http";
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
 * import { createMcpAuth } from "@neon/oauth/mcp";
 * import { nodeMcp, type AuthedIncomingMessage } from "@neon/oauth/mcp/node";
 *
 * const auth = createMcpAuth({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   resource: "https://mcp.example.com/mcp",
 * });
 * const newServer = () => new McpServer({ name: "demo", version: "1.0.0" });
 * const guard = nodeMcp(auth);
 *
 * createServer((req, res) =>
 *   guard(req, res, async (err) => {
 *     const result = (req as AuthedIncomingMessage).auth;
 *     if (err || !result) {
 *       res.statusCode = err ? 500 : 404; // 404: not a guarded MCP request
 *       return res.end();
 *     }
 *     const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
 *     await newServer().connect(transport);
 *     Object.assign(req, { auth: auth.toAuthInfo(result) });
 *     await transport.handleRequest(req, res);
 *   }),
 * ).listen(3000);
 * ```
 */
export function nodeMcp(
	auth: McpAuth,
	opts: NodeMcpOptions = {},
): NodeMiddleware {
	const { path, ...bearer } = opts;
	const target = mcpPath(auth, path);
	const guard = nodeMcpBearerAuth(auth, bearer);
	const metadata = nodeMiddleware((request) =>
		routeMcpMetadata(auth, request),
	);
	return (req, res, next) =>
		metadata(req, res, (err) => {
			if (err) return next(err);
			const { pathname } = new URL(
				(req as { originalUrl?: string }).originalUrl ?? req.url ?? "/",
				"http://localhost",
			);
			if (
				pathname === target &&
				(MCP_METHODS as readonly string[]).includes(req.method ?? "")
			) {
				return guard(req, res, next);
			}
			next();
		});
}
