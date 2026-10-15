/**
 * `@neon/oauth/mcp/next` — Next.js App Router adapters for MCP servers. Route handlers are
 * already Web `Request` -> `Response`, so these are thin.
 *
 * @module
 */
import { authenticateWith } from "../verify/authenticate";
import type { BearerAuthOptions } from "../verify/bearer";
import type { AuthResult } from "../verify/verifier";
import type { McpResourceServer } from "./resource-server";
import { routeMcpMetadata } from "./resource-server";

export type AuthedHandler<C> = (
	request: Request,
	auth: AuthResult,
	routeContext: C,
) => Response | Promise<Response>;

/** Wraps an MCP route handler: 401/403/503 is returned for you, otherwise the handler runs with the verified `AuthResult`. */
export function withMcpAuth<C = unknown>(
	mcp: McpResourceServer,
	handler: AuthedHandler<C>,
	opts: BearerAuthOptions = {},
): (request: Request, routeContext: C) => Promise<Response> {
	return async (request, routeContext) => {
		const outcome = await authenticateWith(mcp, request, opts);
		return outcome.ok
			? handler(request, outcome.auth, routeContext)
			: outcome.response;
	};
}

/**
 * For the RFC 9728 well-known routes, which Next serves outside `/api`:
 * `app/.well-known/oauth-protected-resource/[[...path]]/route.ts` with `export const { GET, OPTIONS } = createMetadataHandlers(mcp)`.
 */
export function createMetadataHandlers(mcp: McpResourceServer) {
	const handle = (request: Request): Response =>
		routeMcpMetadata(mcp, request) ??
		new Response("Not found", { status: 404 });
	return { GET: handle, OPTIONS: handle };
}
