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

/** The verification options of `createOAuth`; the sign-in client settings do not apply to a resource server. */
export type McpAuthOptions = McpOptions & VerifierOptions;

/**
 * An MCP server protected by the Neon Auth issuer at `baseUrl`. Equivalent to
 * `createOAuth({ baseUrl, ... }).mcp({ resource, scopesSupported })` from `@neon/oauth`; use
 * that form instead when the same app also needs `oauth.client` or `oauth.requireBearerAuth`,
 * so they share one discovery cache.
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
