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

/** An MCP route handler that runs only for authenticated requests; it receives the verified `AuthResult` as its second argument. `C` is the framework's route context. */
export type AuthedHandler<C> = (
	request: Request,
	auth: AuthResult,
	routeContext: C,
) => Response | Promise<Response>;

/**
 * Wraps an App Router MCP route handler (a handler wrapper rather than middleware, since Next
 * route handlers have none) so it needs a valid bearer token: 401/403/503 is returned for you, with
 * a challenge carrying `resource_metadata`; otherwise `handler` runs with the verified `AuthResult`.
 * Convert it for the MCP SDK transport with `auth.toAuthInfo(authResult)`. It does not serve the
 * metadata routes: add `createMetadataHandlers` for those.
 *
 * @param mcp The result of `createMcpAuth()`.
 *
 * @example
 * ```ts
 * // app/mcp/route.ts
 * export const POST = withMcpAuth(auth, (req, authResult) => handle(req, auth.toAuthInfo(authResult)));
 * ```
 */
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
 * Route handlers (`GET`, `OPTIONS`) that serve the RFC 9728 protected-resource metadata and its CORS
 * preflight, unauthenticated; other paths answer 404. Put them at the well-known route, which Next
 * serves outside `/api`, in `app/.well-known/oauth-protected-resource/[[...path]]/route.ts`:
 * `export const { GET, OPTIONS } = createMetadataHandlers(auth);`.
 *
 * @param mcp The result of `createMcpAuth()`.
 */
export function createMetadataHandlers(mcp: McpResourceServer) {
	const handle = (request: Request): Response =>
		routeMcpMetadata(mcp, request) ??
		new Response("Not found", { status: 404 });
	return { GET: handle, OPTIONS: handle };
}
