/**
 * `@neon/oauth/mcp/next` — Next.js App Router adapters that guard an MCP server and serve its
 * protected-resource metadata. Route handlers are already Web `Request` to `Response`, so these
 * are thin.
 *
 * @module
 */
import { authenticateWith } from "../verify/authenticate";
import type { BearerAuthOptions } from "../verify/bearer";
import type { AuthResult } from "../verify/verifier";
import type { McpAuth } from "./resource-server";
import { routeMcpMetadata } from "./resource-server";

/**
 * An MCP route handler that runs only for authenticated requests.
 *
 * It receives the verified {@link AuthResult} as its second argument and the framework's route
 * context (`C`) as its third.
 */
export type AuthedHandler<C> = (
	request: Request,
	auth: AuthResult,
	routeContext: C,
) => Response | Promise<Response>;

/**
 * Wraps an App Router MCP route handler so it needs a valid bearer token.
 *
 * A missing or invalid token gets a 401 or 403 `Response` with a challenge carrying `resource_metadata`, or a 503 when the authorization server is unavailable (500 on an unexpected failure); otherwise `handler` runs with the verified {@link AuthResult}. Next route
 * handlers have no middleware, hence a wrapper. It does not serve the metadata routes: add
 * {@link createMetadataHandlers} for those.
 *
 * @typeParam C The route context type, e.g. `{ params: Promise<{ id: string }> }`.
 * @param auth The result of `createMcpAuth()`.
 * @param handler Runs only for authenticated requests; see {@link AuthedHandler}. Convert the
 *   result for the MCP SDK transport with `auth.toAuthInfo(result)`.
 * @param opts Required scopes and `onError`.
 * @returns A route handler `(request, routeContext) => Promise<Response>` to export as `POST`, `GET`, ...
 *
 * @example
 * ```ts
 * // app/mcp/route.ts
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
 * import { createMcpAuth } from "@neon/oauth/mcp";
 * import { withMcpAuth } from "@neon/oauth/mcp/next";
 *
 * const auth = createMcpAuth({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   resource: "https://mcp.example.com/mcp",
 * });
 * const newServer = () => new McpServer({ name: "demo", version: "1.0.0" });
 *
 * export const POST = withMcpAuth(auth, async (request, result) => {
 *   const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
 *   await newServer().connect(transport);
 *   return transport.handleRequest(request, { authInfo: auth.toAuthInfo(result) });
 * });
 * ```
 */
export function withMcpAuth<C = unknown>(
	auth: McpAuth,
	handler: AuthedHandler<C>,
	opts: BearerAuthOptions = {},
): (request: Request, routeContext: C) => Promise<Response> {
	return async (request, routeContext) => {
		const outcome = await authenticateWith(auth, request, opts);
		return outcome.ok
			? handler(request, outcome.auth, routeContext)
			: outcome.response;
	};
}

/**
 * Route handlers (`GET`, `OPTIONS`) that serve the RFC 9728 protected-resource metadata and its
 * CORS preflight, unauthenticated; other paths answer 404.
 *
 * Export them from `app/.well-known/oauth-protected-resource/[[...path]]/route.ts`; the optional
 * catch-all covers both the bare and the path-inserted metadata URL.
 *
 * @param auth The result of `createMcpAuth()`.
 * @returns `{ GET, OPTIONS }`, to destructure as the route's exports.
 * @see {@link withMcpAuth} to guard the MCP endpoint itself.
 *
 * @example
 * ```ts
 * // app/.well-known/oauth-protected-resource/[[...path]]/route.ts
 * import { createMcpAuth } from "@neon/oauth/mcp";
 * import { createMetadataHandlers } from "@neon/oauth/mcp/next";
 *
 * const auth = createMcpAuth({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   resource: "https://mcp.example.com/mcp",
 * });
 *
 * export const { GET, OPTIONS } = createMetadataHandlers(auth);
 * ```
 */
export function createMetadataHandlers(auth: McpAuth) {
	const handle = (request: Request): Response =>
		routeMcpMetadata(auth, request) ??
		new Response("Not found", { status: 404 });
	return { GET: handle, OPTIONS: handle };
}
