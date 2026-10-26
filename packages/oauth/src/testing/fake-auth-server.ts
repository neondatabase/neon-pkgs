// A real HTTP server standing in for Neon Auth, so tests exercise the same fetch + JWKS code paths production does.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { JWTPayload } from "jose";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

/** The only authorization code the fake token endpoint redeems; any other code is `invalid_grant`. */
export const GOOD_CODE = "good-code";

export interface FakeAuthServer {
	issuer: string;
	hits: { discovery: number; jwks: number; token: number; userinfo: number };
	/** Overrides the `issuer` field the discovery document reports. */
	setReportedIssuer(issuer: string): void;
	setDiscoveryDelay(ms: number): void;
	setDiscoveryStatus(status: number): void;
	setTokenDelay(ms: number): void;
	/** Makes the token endpoint answer every request with this status and an OAuth `server_error` body. */
	setTokenStatus(status: number): void;
	setJwksStatus(status: number): void;
	/** Whether discovery advertises `client_id_metadata_document_supported`. Defaults to true. */
	setCimdSupported(supported: boolean): void;
	/** Makes the userinfo endpoint answer with this status; `"drop"` closes the connection without a response. */
	setUserinfoStatus(status: number | "drop"): void;
	/** Claims the userinfo endpoint returns on success. Defaults to `{ sub: "user-1", email, name, ... }`. */
	setUserinfoClaims(claims: Record<string, unknown>): void;
	/** The `sub` of the ID token the authorization-code grant issues. */
	setIdTokenSub(sub: string): void;
	sign(
		claims?: JWTPayload,
		opts?: {
			exp?: string | number;
			aud?: string | string[] | null;
			iss?: string;
			/** `null` omits the `sub` claim. */
			sub?: string | null;
		},
	): Promise<string>;
	close(): Promise<void>;
}

export async function startFakeAuthServer(): Promise<FakeAuthServer> {
	const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
		extractable: true,
	});
	const jwk = {
		...(await exportJWK(publicKey)),
		kid: "k1",
		alg: "EdDSA",
		use: "sig",
	};

	const hits = { discovery: 0, jwks: 0, token: 0, userinfo: 0 };
	// Refresh tokens rotate: redeeming one invalidates it, as a strict authorization server would.
	const spentRefreshTokens = new Set<string>();
	let tokenDelayMs = 0;
	let tokenSeq = 0;
	let reportedIssuer: string | undefined;
	let delayMs = 0;
	let status = 200;
	let tokenStatus = 200;
	let jwksStatus = 200;
	let cimdSupported = true;
	let userinfoStatus: number | "drop" = 200;
	let userinfoClaims: Record<string, unknown> = {
		sub: "user-1",
		email: "user@example.com",
		email_verified: true,
		name: "User One",
		picture: "https://img.test/u1.png",
	};
	let idTokenSub = "user-1";
	let issuer = "";

	const signToken = (
		claims: JWTPayload,
		opts: {
			exp?: string | number;
			aud?: string | string[] | null;
			iss?: string;
			sub?: string | null;
		},
	) => {
		const jwt = new SignJWT({
			client_id: "client-1",
			scope: "openid profile",
			...claims,
		})
			.setProtectedHeader({ alg: "EdDSA", kid: "k1" })
			.setIssuer(opts.iss ?? issuer)
			.setIssuedAt()
			.setExpirationTime(opts.exp ?? "5m");
		if (opts.sub !== null) jwt.setSubject(opts.sub ?? "user-1");
		if (opts.aud !== null)
			jwt.setAudience(opts.aud ?? "http://api.test/mcp");
		return jwt.sign(privateKey);
	};

	const server = createServer((req, res) => {
		const json = (code: number, body: unknown) => {
			res.writeHead(code, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (req.url === "/auth/.well-known/oauth-authorization-server") {
			hits.discovery++;
			setTimeout(
				() =>
					status === 200
						? json(200, {
								issuer: reportedIssuer ?? issuer,
								jwks_uri: `${issuer}/jwks.json`,
								authorization_endpoint: `${issuer}/authorize`,
								token_endpoint: `${issuer}/token`,
								client_id_metadata_document_supported:
									cimdSupported,
								userinfo_endpoint: `${issuer}/userinfo`,
							})
						: json(status, {}),
				delayMs,
			);
		} else if (req.url === "/auth/jwks.json") {
			hits.jwks++;
			json(jwksStatus, jwksStatus === 200 ? { keys: [jwk] } : {});
		} else if (req.url === "/auth/token" && req.method === "POST") {
			hits.token++;
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () =>
				setTimeout(async () => {
					if (tokenStatus !== 200)
						return json(tokenStatus, { error: "server_error" });
					const form = new URLSearchParams(body);
					if (
						form.get("grant_type") === "authorization_code" &&
						form.get("code") === GOOD_CODE
					) {
						const idToken = await new SignJWT({})
							.setProtectedHeader({ alg: "EdDSA", kid: "k1" })
							.setIssuer(issuer)
							.setSubject(idTokenSub)
							.setAudience("c1")
							.setIssuedAt()
							.setExpirationTime("5m")
							.sign(privateKey);
						return json(200, {
							access_token: await signToken(
								{},
								{
									aud: form.get("resource") ?? undefined,
									sub: idTokenSub,
								},
							),
							id_token: idToken,
							token_type: "Bearer",
							expires_in: 300,
							refresh_token: `refresh-${++tokenSeq}`,
						});
					}
					const presented = form.get("refresh_token") ?? "";
					if (
						form.get("grant_type") !== "refresh_token" ||
						spentRefreshTokens.has(presented)
					) {
						return json(400, { error: "invalid_grant" });
					}
					spentRefreshTokens.add(presented);
					json(200, {
						access_token: await signToken(
							{},
							{ aud: form.get("resource") ?? undefined },
						),
						token_type: "Bearer",
						expires_in: 300,
						refresh_token: `refresh-${++tokenSeq}`,
					});
				}, tokenDelayMs),
			);
		} else if (req.url === "/auth/userinfo") {
			hits.userinfo++;
			if (userinfoStatus === "drop") return req.socket.destroy();
			json(
				userinfoStatus,
				userinfoStatus === 200
					? userinfoClaims
					: { error: "server_error" },
			);
		} else {
			json(404, {});
		}
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth`;

	return {
		issuer,
		hits,
		setReportedIssuer: (v) => (reportedIssuer = v),
		setDiscoveryDelay: (v) => (delayMs = v),
		setDiscoveryStatus: (v) => (status = v),
		setTokenDelay: (v) => (tokenDelayMs = v),
		setTokenStatus: (v) => (tokenStatus = v),
		setJwksStatus: (v) => (jwksStatus = v),
		setCimdSupported: (v) => (cimdSupported = v),
		setUserinfoStatus: (v) => (userinfoStatus = v),
		setUserinfoClaims: (v) => (userinfoClaims = v),
		setIdTokenSub: (v) => (idTokenSub = v),
		sign: (claims = {}, opts = {}) => signToken(claims, opts),
		close: () => new Promise((r) => server.close(() => r())),
	};
}
