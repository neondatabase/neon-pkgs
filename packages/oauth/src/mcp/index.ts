/**
 * `@neon/oauth/mcp` — protect an MCP server with Neon Auth. Everything needed to guard an MCP
 * endpoint and nothing about sign-in: it imports the jose-only verifier core and never loads
 * `openid-client`.
 *
 * **Stability: beta.** Minor versions may include breaking changes.
 *
 * @module
 */

import type { VerifierOptions } from "../verify/verifier";
import { createVerifier } from "../verify/verifier";
import type { McpOptions, McpResourceServer } from "./resource-server";
import { createMcp } from "./resource-server";

export type { BearerAuthOptions } from "../verify/bearer";
export type { InvalidTokenCode } from "../verify/errors";
export {
	AuthServerUnavailableError,
	InvalidTokenError,
	OAuthConfigError,
	OAuthError,
} from "../verify/errors";
export type { AuthResult, VerifyResult } from "../verify/verifier";
export type { McpOptions, McpResourceServer } from "./resource-server";
export {
	MCP_METHODS,
	mcpPath,
	routeMcpMetadata,
	toAuthInfo,
} from "./resource-server";

/** Options for `createMcpAuth`: `McpOptions` plus the verification options of `createOAuth` (the sign-in client settings do not apply). */
export type McpAuthOptions = McpOptions & VerifierOptions;

/**
 * Creates the authentication for an MCP server whose tokens are issued by the Neon Auth issuer at
 * `baseUrl`. It does not create an MCP server: it returns the helper (`McpResourceServer`)
 * that verifies tokens bound to the MCP `resource` and serves the protected-resource metadata
 * (RFC 9728) MCP clients use to discover the authorization server. Pass it to an MCP adapter such
 * as `honoMcp`, `expressMcp`, `nodeMcp` or `withMcpAuth`, which serve that metadata and guard the
 * MCP endpoint.
 *
 * Equivalent to `createOAuth({ baseUrl, ... }).mcp({ resource, scopesSupported })` from `@neon/oauth`
 * without the sign-in client. Use that form instead when the same app also needs `oauth.client`
 * or `oauth.requireBearerAuth()`, so they share one discovery cache.
 *
 * Throws `OAuthConfigError` when `baseUrl` or `resource` is missing or not an absolute URL.
 * Nothing is fetched until the first request.
 *
 * @example
 * ```ts
 * import { createMcpAuth } from "@neon/oauth/mcp";
 * import { honoMcp } from "@neon/oauth/mcp/hono";
 *
 * const auth = createMcpAuth({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   resource: "https://mcp.example.com/mcp",
 * });
 * app.use(honoMcp(auth));
 * ```
 */
export function createMcpAuth({
	resource,
	scopesSupported,
	...verifierOptions
}: McpAuthOptions): McpResourceServer {
	return createMcp(createVerifier(verifierOptions), {
		resource,
		scopesSupported,
	});
}
