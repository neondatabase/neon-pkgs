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
import type { McpAuth, McpOptions } from "./resource-server";
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
export type { McpAuth, McpOptions } from "./resource-server";
export {
	MCP_METHODS,
	mcpPath,
	routeMcpMetadata,
	toAuthInfo,
} from "./resource-server";

/** Options for {@link createMcpAuth}: {@link McpOptions} plus the token-verification options (`baseUrl`, `algorithms`, ...). Sign-in client settings do not apply. */
export type McpAuthOptions = McpOptions & VerifierOptions;

/**
 * Creates the authentication helper for an MCP server whose tokens come from the Neon Auth issuer
 * at `baseUrl`.
 *
 * It does not create an MCP server. It returns an {@link McpAuth} that verifies tokens
 * bound to the MCP `resource` and serves the RFC 9728 protected-resource metadata MCP clients use
 * to find the authorization server. Pass it to an MCP adapter (`honoMcp`, `expressMcp`,
 * `nodeMcp`, `withMcpAuth`), which serves that metadata and guards the endpoint.
 *
 * Equivalent to `createOAuth(...).mcp(...)` without loading the sign-in client; use that form when
 * the same app also signs users in, so everything shares one discovery cache. Nothing is fetched
 * until the first request. The example's Web-standard transport needs `@modelcontextprotocol/sdk`
 * 1.25.0 or later.
 *
 * @param options The MCP `resource`, optional `scopesSupported`, and the verification options.
 * @returns The helper to pass to an MCP adapter.
 * @throws {OAuthConfigError} If `baseUrl` or `resource` is missing or not an absolute URL.
 * @see `routeMcpMetadata` to serve the metadata without an adapter.
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { createMcpAuth } from "@neon/oauth/mcp";
 * import { honoMcp, type McpAuthVariables } from "@neon/oauth/mcp/hono";
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
 *
 * const auth = createMcpAuth({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   resource: "https://mcp.example.com/mcp",
 * });
 * const newServer = () => new McpServer({ name: "demo", version: "1.0.0" });
 *
 * const app = new Hono<McpAuthVariables>();
 * app.use(honoMcp(auth));
 * app.all("/mcp", async (c) => {
 *   const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
 *   await newServer().connect(transport);
 *   return transport.handleRequest(c.req.raw, { authInfo: c.get("authInfo") });
 * });
 * ```
 */
export function createMcpAuth({
	resource,
	scopesSupported,
	...verifierOptions
}: McpAuthOptions): McpAuth {
	return createMcp(createVerifier(verifierOptions), {
		resource,
		scopesSupported,
	});
}
