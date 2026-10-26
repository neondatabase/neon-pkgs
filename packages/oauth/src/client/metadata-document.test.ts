import { describe, expect, it } from "vitest";

import { OAuthConfigError } from "../verify/errors";
import { createClientMetadataDocument } from "./metadata-document";

const CLIENT_ID = "https://app.example.com/oauth/client-metadata.json";
const base = {
	clientId: CLIENT_ID,
	clientName: "Reports",
	redirectUris: ["https://app.example.com/api/auth/callback"],
};

describe("createClientMetadataDocument", () => {
	it("produces a public-client document whose client_id is its own URL", () => {
		expect(createClientMetadataDocument(base)).toEqual({
			client_id: CLIENT_ID,
			client_name: "Reports",
			redirect_uris: ["https://app.example.com/api/auth/callback"],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		});
	});

	it("includes optional fields only when given", () => {
		const doc = createClientMetadataDocument({
			...base,
			clientUri: "https://app.example.com",
			logoUri: "https://app.example.com/logo.png",
			scope: "openid profile",
			grantTypes: ["authorization_code"],
		});
		expect(doc).toMatchObject({
			client_uri: "https://app.example.com",
			logo_uri: "https://app.example.com/logo.png",
			scope: "openid profile",
			grant_types: ["authorization_code"],
		});
	});

	it("accepts loopback http and custom-scheme redirect URIs", () => {
		const doc = createClientMetadataDocument({
			...base,
			redirectUris: [
				"http://localhost:3000/callback",
				"http://127.0.0.1/callback",
				"http://[::1]:8080/callback",
				"cursor://anysphere.cursor-retrieval/oauth/callback",
			],
		});
		expect(doc.redirect_uris).toHaveLength(4);
	});

	it.each([
		["http clientId", { clientId: "http://app.example.com/c.json" }],
		["no path", { clientId: "https://app.example.com" }],
		["root path", { clientId: "https://app.example.com/" }],
		["fragment", { clientId: "https://app.example.com/c.json#x" }],
		["credentials", { clientId: "https://u:p@app.example.com/c.json" }],
		["dot segments", { clientId: "https://app.example.com/a/../c.json" }],
		["not a URL", { clientId: "client-1" }],
		["empty name", { clientName: "" }],
		["no redirect URIs", { redirectUris: [] }],
		["relative redirect URI", { redirectUris: ["/callback"] }],
		[
			"remote http redirect URI",
			{ redirectUris: ["http://app.example.com/callback"] },
		],
		[
			"redirect URI with fragment",
			{ redirectUris: ["https://app.example.com/cb#x"] },
		],
		["javascript redirect URI", { redirectUris: ["javascript:alert(1)"] }],
		["http logoUri", { logoUri: "http://app.example.com/logo.png" }],
		["http clientUri", { clientUri: "http://app.example.com" }],
	])("rejects %s", (_label, override) => {
		expect(() =>
			createClientMetadataDocument({ ...base, ...override }),
		).toThrow(OAuthConfigError);
	});
});
