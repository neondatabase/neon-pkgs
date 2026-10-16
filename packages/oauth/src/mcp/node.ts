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
export type AuthedIncomingMessage = IncomingMessage & { auth?: AuthResult };

/** Bearer guard. On success the verified `AuthResult` is at `req.auth` and `next()` is called. */
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

export interface NodeMcpOptions extends BearerAuthOptions {
	/** MCP endpoint path. Defaults to the path of `resource`. */
	path?: string;
}

/** Serves the metadata routes and guards POST/GET/DELETE on the MCP path. Everything else calls `next()`. */
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
