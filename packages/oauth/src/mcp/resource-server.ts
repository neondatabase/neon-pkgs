// MCP flavour of a protected resource: the MCP endpoint URL is the audience, challenges carry
// `resource_metadata`, and the RFC 9728 metadata document is served for MCP client discovery.
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { BearerAuthOptions, BearerGuard } from "../verify/bearer";
import {
	createBearerGuard,
	protectedResourceMetadataUrl,
} from "../verify/bearer";
import { OAuthConfigError } from "../verify/errors";
import type { AuthResult, Verifier, VerifyResult } from "../verify/verifier";

/** Settings for the authentication of one MCP server: the argument of `oauth.mcp()`, and (with the verification options) of `createMcpAuth`. */
export interface McpOptions {
	/** Public URL of the MCP endpoint, e.g. `https://mcp.example.com/mcp`. Must be an absolute URL. Clients send it as `resource`, and it becomes the token's `aud`. */
	resource: string;
	/**
	 * Scopes advertised as `scopes_supported` in the protected-resource metadata document.
	 *
	 * @defaultValue omitted from the metadata document
	 */
	scopesSupported?: string[];
}

/**
 * Converts a verified {@link AuthResult} into the MCP TypeScript SDK's `AuthInfo` (the type from
 * `@modelcontextprotocol/sdk/server/auth/types.js`).
 *
 * Pass it to the SDK transport as `transport.handleRequest(req, { authInfo })`; the SDK then hands
 * it to your tool handlers as `extra.authInfo`, so a tool can see who is calling and with which
 * scopes. Hono exposes it already, as `c.get("authInfo")`. With `expressMcp`, `nodeMcp`,
 * `withMcpAuth` or `authenticate`, call this on the `AuthResult` they give you.
 *
 * Mapping:
 * - `token`: the raw bearer token.
 * - `clientId`: the `client_id` claim, or `""` when the token has none (the SDK requires a string).
 * - `scopes`: the token's scopes.
 * - `expiresAt`: the `exp` claim, in seconds since the epoch.
 * - `resource`: the first audience, as a `URL`, when it is a valid URL.
 * - `extra.claims`: the full verified JWT payload.
 *
 * @param result The verified token.
 * @returns The SDK's `AuthInfo`.
 *
 * @example
 * ```ts
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 *
 * const server = new McpServer({ name: "demo", version: "1.0.0" });
 * server.registerTool("whoami", { description: "Who is calling" }, (extra) => {
 *   const info = extra.authInfo; // set from toAuthInfo by the transport
 *   const claims = info?.extra?.claims as { sub?: string } | undefined;
 *   return {
 *     content: [{ type: "text", text: `${claims?.sub} via ${info?.clientId} (${info?.scopes.join(" ")})` }],
 *   };
 * });
 * ```
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
 * The auth helper for one MCP server, returned by `createMcpAuth` and `oauth.mcp()`; it plays the
 * OAuth "resource server" role (RFC 9728).
 *
 * It is not an MCP server: it verifies tokens bound to the MCP `resource` and serves the
 * protected-resource metadata that MCP clients use to find the authorization server. Pass it to an
 * MCP adapter (`honoMcp`, `expressMcp`, `nodeMcp`, `withMcpAuth`, ...) or to `authenticate`.
 */
export interface McpAuth {
	/** The issuer: the Neon Auth `baseUrl` without a trailing slash. */
	readonly issuer: string;
	/** The MCP endpoint URL; the audience tokens must carry. */
	readonly resource: string;
	/** The path-inserted RFC 9728 metadata URL, sent as `resource_metadata` in 401/403 challenges. */
	readonly resourceMetadataUrl: string;
	/** Paths the metadata document is served on: the path-inserted one, plus the bare `/.well-known/oauth-protected-resource` fallback. One entry when the two coincide (a `resource` with no path). */
	readonly metadataPaths: string[];
	/**
	 * Verifies a raw access token against `resource`.
	 *
	 * @param token The bearer token, without the `Bearer ` prefix.
	 * @returns `{ ok: true, auth }`, or `{ ok: false, reason: "invalid_token", code, message }` for a bad token.
	 * @throws {AuthServerUnavailableError} If the discovery document or signing keys cannot be fetched, or
	 *   verification fails for a reason other than the token itself.
	 */
	verifyAccessToken(token: string): Promise<VerifyResult>;
	/**
	 * Creates a framework-neutral {@link BearerGuard} for the MCP endpoint, bound to `resource`.
	 * Its 401/403 challenges carry `resource_metadata`.
	 *
	 * @param opts Required scopes and `onError`.
	 * @returns A guard that never throws.
	 */
	requireBearerAuth(opts?: BearerAuthOptions): BearerGuard;
	/** Returns the RFC 9728 metadata document body: `resource`, `authorization_servers` and, when configured, `scopes_supported`. */
	protectedResourceMetadata(): {
		resource: string;
		authorization_servers: string[];
		scopes_supported?: string[];
	};
	/**
	 * Answers GET and OPTIONS (CORS preflight) on `metadataPaths`; see {@link routeMcpMetadata}.
	 *
	 * @returns The `Response`, or `undefined` for any other request so the caller keeps routing.
	 */
	handleMetadataRequest(request: Request): Response | undefined;
	/** Same as the standalone {@link toAuthInfo}: converts an `AuthResult` into the MCP SDK's `AuthInfo`. */
	toAuthInfo(result: AuthResult): AuthInfo;
}

const WELL_KNOWN_BARE = "/.well-known/oauth-protected-resource";

// Browser-based MCP clients fetch the metadata cross-origin before they have a token.
const CORS = { "access-control-allow-origin": "*" };

/** Builds the {@link McpAuth} on a shared verifier. Internal: use `createMcpAuth` or `oauth.mcp()`. */
export function createMcp(
	verifier: Verifier,
	{ resource, scopesSupported }: McpOptions,
): McpAuth {
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
 * Answers the RFC 9728 protected-resource metadata request and its CORS preflight, for building
 * your own MCP adapter or fetch handler. The built-in MCP adapters already call it.
 *
 * Responds to GET and OPTIONS on the metadata paths (path-inserted and bare), unauthenticated by design.
 *
 * @param auth The result of `createMcpAuth()`.
 * @param request The incoming request; only its method and URL path are read.
 * @returns The `Response`, or `undefined` for any other request so the caller keeps routing.
 *
 * @example
 * ```ts
 * import { createMcpAuth, routeMcpMetadata } from "@neon/oauth/mcp";
 *
 * const auth = createMcpAuth({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   resource: "https://mcp.example.com/mcp",
 * });
 *
 * export default {
 *   async fetch(request: Request) {
 *     return routeMcpMetadata(auth, request) ?? new Response("Not found", { status: 404 });
 *   },
 * };
 * ```
 */
export function routeMcpMetadata(
	auth: McpAuth,
	request: Request,
): Response | undefined {
	return auth.handleMetadataRequest(request);
}

/** The Streamable HTTP methods (`POST`, `GET`, `DELETE`) the MCP adapters guard on the MCP endpoint. Use it when building your own MCP adapter. */
export const MCP_METHODS = ["POST", "GET", "DELETE"] as const;

/** Returns the path of the MCP endpoint: `path` if given, else the path of the server's `resource` URL. Use it when building your own MCP adapter. */
export const mcpPath = (auth: McpAuth, path?: string): string =>
	path ?? new URL(auth.resource).pathname;
