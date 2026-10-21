// Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document): the client_id is the https URL
// of this JSON, which the authorization server fetches. The client itself never fetches anything.
import { OAuthConfigError } from "../verify/errors";

/** Input to {@link createClientMetadataDocument}. */
export interface ClientMetadataDocumentOptions {
	/** The https URL this document is served from. Must be in canonical form with a path, and have no fragment or credentials. */
	clientId: string;
	/** Name shown on the consent screen. */
	clientName: string;
	/** Allowed redirect URIs: https, `http` on a loopback host, or a custom scheme. At least one; none may contain a fragment. */
	redirectUris: string[];
	/** An https URL of the client's home page. */
	clientUri?: string;
	/** An https URL of the client's logo, shown on the consent screen. */
	logoUri?: string;
	/** Space-separated scopes the client may request. */
	scope?: string;
	/**
	 * OAuth grant types the client uses.
	 *
	 * @defaultValue `["authorization_code", "refresh_token"]`
	 */
	grantTypes?: string[];
}

/** The JSON document served at the `client_id` URL, in the snake_case wire format authorization servers fetch. Client ID Metadata Document clients are public: PKCE, no client secret. */
export interface ClientMetadataDocument {
	/** The URL the document is served from. */
	client_id: string;
	/** Name shown on the consent screen. */
	client_name: string;
	/** Allowed redirect URIs. */
	redirect_uris: string[];
	/** Grant types the client uses. */
	grant_types: string[];
	/** Always `["code"]` (authorization code flow). */
	response_types: ["code"];
	/** Always `"none"`: a public client authenticating with PKCE. */
	token_endpoint_auth_method: "none";
	/** The client's home page, when given. */
	client_uri?: string;
	/** The client's logo, when given. */
	logo_uri?: string;
	/** Space-separated scopes, when given. */
	scope?: string;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const FORBIDDEN_SCHEMES = [
	"javascript:",
	"data:",
	"vbscript:",
	"file:",
	"blob:",
];

/** Whether `clientId` is the https URL form that selects Client ID Metadata Documents. */
export function isMetadataDocumentClientId(clientId: string): boolean {
	return URL.canParse(clientId) && new URL(clientId).protocol === "https:";
}

function assertClientId(clientId: string): void {
	const fail = (why: string) =>
		new OAuthConfigError(
			`clientId must be the https URL of the metadata document: ${why}, got "${clientId}".`,
		);
	if (!URL.canParse(clientId)) throw fail("not an absolute URL");
	const url = new URL(clientId);
	if (url.protocol !== "https:") throw fail("scheme is not https");
	if (url.username || url.password) throw fail("it has credentials");
	if (clientId.includes("#")) throw fail("it has a fragment");
	if (url.pathname === "/") throw fail("it has no path");
	// URL normalizes dot segments and host case, so a changed href means the string is not canonical.
	if (url.href !== clientId) throw fail("not in canonical form");
}

function assertRedirectUri(uri: string): void {
	const fail = (why: string) =>
		new OAuthConfigError(`Invalid redirect URI "${uri}": ${why}.`);
	if (!URL.canParse(uri)) throw fail("not an absolute URL");
	if (uri.includes("#")) throw fail("it has a fragment");
	const url = new URL(uri);
	if (FORBIDDEN_SCHEMES.includes(url.protocol)) {
		throw fail(`scheme ${url.protocol} is not allowed`);
	}
	if (url.protocol === "http:" && !LOOPBACK_HOSTS.includes(url.hostname)) {
		throw fail("http is only allowed on a loopback host");
	}
}

function assertHttpsUrl(name: string, value: string): void {
	if (!URL.canParse(value) || new URL(value).protocol !== "https:") {
		throw new OAuthConfigError(
			`${name} must be an https URL, got "${value}".`,
		);
	}
}

/**
 * Builds the Client ID Metadata Document for a public client whose `client_id` is an https URL,
 * so no registration step or secret is needed.
 *
 * Use it for an MCP or other public client; use a pre-registered `clientId` otherwise. Serve the
 * result at `clientId` with a framework adapter (`createClientMetadataHandlers`,
 * `honoClientMetadata`, `expressClientMetadata`, `nodeClientMetadata`) and pass the same
 * `clientId` to `createOAuth`. The authorization server fetches the document; your app never does.
 *
 * @param options See {@link ClientMetadataDocumentOptions}.
 * @returns The document to serve as JSON.
 * @throws {OAuthConfigError} If `clientId` is not a canonical https URL with a path (and no
 *   fragment or credentials), `clientName` is empty, `redirectUris` is empty or contains an invalid
 *   URI (a fragment, a forbidden scheme, or `http` on a non-loopback host), or `clientUri` /
 *   `logoUri` is not https.
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { createClientMetadataDocument } from "@neon/oauth";
 * import { honoClientMetadata } from "@neon/oauth/hono";
 *
 * const doc = createClientMetadataDocument({
 *   clientId: "https://app.example.com/oauth/client.json",
 *   clientName: "Reports",
 *   redirectUris: ["https://app.example.com/api/auth/callback"],
 * });
 *
 * const app = new Hono();
 * app.use(honoClientMetadata(doc));
 * ```
 */
export function createClientMetadataDocument(
	options: ClientMetadataDocumentOptions,
): ClientMetadataDocument {
	const { clientId, clientName, redirectUris, clientUri, logoUri, scope } =
		options;
	assertClientId(clientId);
	if (!clientName) throw new OAuthConfigError("clientName is required.");
	if (redirectUris.length === 0) {
		throw new OAuthConfigError("At least one redirect URI is required.");
	}
	for (const uri of redirectUris) assertRedirectUri(uri);
	if (clientUri) assertHttpsUrl("clientUri", clientUri);
	if (logoUri) assertHttpsUrl("logoUri", logoUri);
	return {
		client_id: clientId,
		client_name: clientName,
		redirect_uris: [...redirectUris],
		grant_types: options.grantTypes ?? [
			"authorization_code",
			"refresh_token",
		],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
		...(clientUri && { client_uri: clientUri }),
		...(logoUri && { logo_uri: logoUri }),
		...(scope && { scope }),
	};
}
