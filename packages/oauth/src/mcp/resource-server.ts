// MCP flavour of a protected resource: the MCP endpoint URL is the audience, challenges carry
// `resource_metadata`, and the RFC 9728 metadata document is served for MCP client discovery.
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { BearerAuthOptions } from "../verify/bearer";
import {
	createBearerGuard,
	protectedResourceMetadataUrl,
} from "../verify/bearer";
import { OAuthConfigError } from "../verify/errors";
import type { AuthResult, Verifier } from "../verify/verifier";

/** Settings for the authentication of one MCP server, as taken by `oauth.mcp()` and (with the verification options) `createMcpAuth`. */
export interface McpOptions {
	/** Public URL of the MCP endpoint, e.g. `https://host/mcp`. Clients send it as `resource`; it becomes the token `aud`. Must be an absolute URL. */
	resource: string;
	/** Scopes advertised as `scopes_supported` in the protected-resource metadata document. */
	scopesSupported?: string[];
}

/**
 * Maps a verified `AuthResult` to the MCP SDK's `AuthInfo`, which the SDK transport takes as
 * `transport.handleRequest(req, { authInfo })`; claims are kept under `extra.claims`. The MCP
 * adapters already do this and expose it as `authInfo`; call it yourself only when you take an
 * `AuthResult` from `authenticate` or `withMcpAuth`. The SDK requires `clientId` to be a string,
 * so a token without a `client_id` claim maps to `""`.
 */
export function toAuthInfo(result: AuthResult): AuthInfo {
	const [audience] = result.audience;
	return {
		token: result.token,
		clientId: result.clientId ?? "",
		scopes: result.scopes,
		expiresAt: result.expiresAt,
		resource:
			audience && URL.canParse(audience) ? new URL(audience) : undefined,
		extra: { claims: result.claims },
	};
}

/**
 * The authentication helper for one MCP server, returned by `createMcpAuth` and `oauth.mcp()`.
 * It is not an MCP server: it verifies tokens bound to the MCP `resource` and serves the
 * RFC 9728 protected-resource metadata that MCP clients use to find the authorization server. Hand it
 * to an MCP adapter (`honoMcp`, `expressMcp`, `nodeMcp`, `withMcpAuth`, ...) or to `authenticate`.
 *
 * Members: `issuer`; `resource` (the audience); `resourceMetadataUrl` (put in 401/403 challenges);
 * `metadataPaths` (the paths the metadata is served on: path-inserted, plus the bare well-known
 * fallback); `verifyAccessToken(token)` (against `resource`; a bad token is
 * `{ ok: false, reason: "invalid_token", code }`, an outage throws `AuthServerUnavailableError`);
 * `requireBearerAuth(opts?)` (a `BearerGuard` whose challenges carry `resource_metadata`);
 * `protectedResourceMetadata()` (the metadata body); `handleMetadataRequest(request)` (same as
 * `routeMcpMetadata`); and `toAuthInfo(auth)`.
 */
export type McpResourceServer = ReturnType<typeof createMcp>;

const WELL_KNOWN_BARE = "/.well-known/oauth-protected-resource";

// Browser-based MCP clients fetch the metadata cross-origin before they have a token.
const CORS = { "access-control-allow-origin": "*" };

/**
 * Builds the `McpResourceServer` on a shared verifier. Internal: use `createMcpAuth`
 * (`@neon/oauth/mcp`) or `oauth.mcp()` (`@neon/oauth`).
 */
export function createMcp(
	verifier: Verifier,
	{ resource, scopesSupported }: McpOptions,
) {
	if (!URL.canParse(resource)) {
		throw new OAuthConfigError(
			`MCP \`resource\` must be an absolute URL, got "${resource}".`,
		);
	}
	const resourceMetadataUrl = protectedResourceMetadataUrl(resource);
	// The path-inserted URL is canonical; the bare path is a fallback for clients that probe the root.
	const metadataPaths = [
		...new Set([new URL(resourceMetadataUrl).pathname, WELL_KNOWN_BARE]),
	];

	/** RFC 9728 body. */
	function protectedResourceMetadata() {
		return {
			resource,
			authorization_servers: [verifier.issuer],
			...(scopesSupported && { scopes_supported: scopesSupported }),
		};
	}

	/**
	 * Framework-neutral metadata endpoint: a `Response` for GET/OPTIONS on the metadata paths,
	 * otherwise `undefined` so the caller continues routing.
	 */
	function handleMetadataRequest(request: Request): Response | undefined {
		if (!metadataPaths.includes(new URL(request.url).pathname))
			return undefined;
		if (request.method === "GET")
			return Response.json(protectedResourceMetadata(), {
				headers: CORS,
			});
		if (request.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: {
					...CORS,
					"access-control-allow-methods": "GET, OPTIONS",
					"access-control-allow-headers": "*",
				},
			});
		}
		return undefined;
	}

	return {
		issuer: verifier.issuer,
		resource,
		resourceMetadataUrl,
		metadataPaths,
		verifyAccessToken: (token: string) =>
			verifier.verifyAccessToken(token, resource),
		requireBearerAuth: (opts: BearerAuthOptions = {}) =>
			createBearerGuard(verifier, resource, {
				...opts,
				resourceMetadataUrl: true,
			}),
		protectedResourceMetadata,
		handleMetadataRequest,
		toAuthInfo,
	};
}

/**
 * Serves the RFC 9728 protected-resource metadata document and its CORS preflight: a `Response`
 * for GET/OPTIONS on the metadata paths (path-inserted and bare, unauthenticated by design),
 * `undefined` for any other request so the caller keeps routing. Use it when building your own
 * MCP adapter or fetch handler; the built-in MCP adapters already call it.
 *
 * @example
 * ```ts
 * export default {
 *   async fetch(request: Request) {
 *     return routeMcpMetadata(auth, request) ?? new Response("Not found", { status: 404 });
 *   },
 * };
 * ```
 */
export function routeMcpMetadata(
	mcp: McpResourceServer,
	request: Request,
): Response | undefined {
	return mcp.handleMetadataRequest(request);
}

/** The Streamable HTTP methods (`POST`, `GET`, `DELETE`) the MCP adapters guard on the MCP endpoint. For building your own MCP adapter. */
export const MCP_METHODS = ["POST", "GET", "DELETE"] as const;

/** The path of the MCP endpoint: `path` if given, else the path of the server's `resource` URL. For building your own MCP adapter. */
export const mcpPath = (mcp: McpResourceServer, path?: string): string =>
	path ?? new URL(mcp.resource).pathname;
