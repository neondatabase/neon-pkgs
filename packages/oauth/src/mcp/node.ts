/**
 * `@neon/oauth/mcp/node` — `node:http` adapters for MCP servers.
 *
 * @module
 */
import type { IncomingMessage } from "node:http";
import type { NodeMiddleware } from "../internal/node";
import { nodeMiddleware } from "../internal/node";
import { authenticateWith } from "../verify/authenticate";
import type { BearerAuthOptions } from "../verify/bearer";
import type { AuthResult } from "../verify/verifier";
import type { McpResourceServer } from "./resource-server";
import { MCP_METHODS, mcpPath, routeMcpMetadata } from "./resource-server";

export type { NodeMiddleware };
/** A `node:http` request after the MCP guards have run: `auth` is the verified token. */
export type AuthedIncomingMessage = IncomingMessage & { auth?: AuthResult };

/**
 * `node:http` middleware that requires a valid bearer token for an MCP server route. On success it
 * sets `req.auth` (the verified `AuthResult`) and calls `next()`; otherwise it responds 401/403/503
 * with a challenge carrying `resource_metadata`. It does not serve the metadata routes: use `nodeMcp`
 * for the whole MCP endpoint.
 *
 * @param mcp The result of `createMcpAuth()`.
 */
export function nodeMcpBearerAuth(
	mcp: McpResourceServer,
	opts: BearerAuthOptions = {},
): NodeMiddleware {
	return nodeMiddleware(async (request, req) => {
		const outcome = await authenticateWith(mcp, request, opts);
		if (!outcome.ok) return outcome.response;
		(req as AuthedIncomingMessage).auth = outcome.auth;
		return undefined;
	});
}

/** Options for `nodeMcp` and `expressMcp`: the bearer options, plus the endpoint path. */
export interface NodeMcpOptions extends BearerAuthOptions {
	/** MCP endpoint path. Defaults to the path of `resource`. */
	path?: string;
}

/**
 * `node:http` middleware (`(req, res, next)`) that protects an MCP endpoint in one call. It serves
 * the RFC 9728 protected-resource metadata and its CORS preflight (unauthenticated), requires a
 * valid bearer token on POST/GET/DELETE (the Streamable HTTP methods) at the MCP path (401/403/503
 * are answered for you), and calls `next()` for everything else. For authenticated requests
 * `req.auth` is the verified `AuthResult` (see `AuthedIncomingMessage`).
 *
 * @param mcp The result of `createMcpAuth()`.
 *
 * @example
 * ```ts
 * const auth = createMcpAuth({ baseUrl, resource: "https://mcp.example.com/mcp" });
 * const mcpMiddleware = nodeMcp(auth);
 * createServer((req, res) => mcpMiddleware(req, res, () => handleMcp(req, res, auth)));
 * ```
 */
export function nodeMcp(
	mcp: McpResourceServer,
	opts: NodeMcpOptions = {},
): NodeMiddleware {
	const { path, ...bearer } = opts;
	const target = mcpPath(mcp, path);
	const guard = nodeMcpBearerAuth(mcp, bearer);
	const metadata = nodeMiddleware((request) =>
		routeMcpMetadata(mcp, request),
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
