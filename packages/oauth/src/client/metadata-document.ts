// Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document): the client_id is the https URL
// of this JSON, which the authorization server fetches. The client itself never fetches anything.
import { OAuthConfigError } from "../verify/errors";

export interface ClientMetadataDocumentOptions {
	/** The https URL this document is served from. Must have a path and no fragment or credentials. */
	clientId: string;
	/** Shown on the consent screen. */
	clientName: string;
	/** https, `http` on a loopback host, or a custom scheme. */
	redirectUris: string[];
	clientUri?: string;
	logoUri?: string;
	scope?: string;
	/** Defaults to `["authorization_code", "refresh_token"]`. */
	grantTypes?: string[];
}

/** CIMD clients are public: PKCE, no client secret. */
export interface ClientMetadataDocument {
	client_id: string;
	client_name: string;
	redirect_uris: string[];
	grant_types: string[];
	response_types: ["code"];
	token_endpoint_auth_method: "none";
	client_uri?: string;
	logo_uri?: string;
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
 * Builds the document to serve at `clientId`. Serve it with a framework adapter
 * (`createClientMetadataHandlers`, `honoClientMetadata`, ...) and pass the same `clientId` to `createOAuth`.
 * Throws `OAuthConfigError` for an invalid field.
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
