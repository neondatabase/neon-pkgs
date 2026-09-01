import { createReadStream } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import open from "open";
import * as client from "openid-client";
import { sendError } from "./analytics.js";
import { matchErrorCode } from "./errors.js";
import { log } from "./log.js";
import type { ExtendedTokenSet } from "./types.js";
import { extendTokenSet } from "./utils/auth.js";

// oauth server timeouts
const SERVER_TIMEOUT = 10_000;
// where to wait for incoming redirect request from oauth server to arrive
const REDIRECT_URI = (port: number) => `http://127.0.0.1:${port}/callback`;
// These scopes cannot be cancelled, they are always needed.
const ALWAYS_PRESENT_SCOPES = ["openid", "offline", "offline_access"] as const;

const NEONCTL_SCOPES = [
	...ALWAYS_PRESENT_SCOPES,
	"urn:neoncloud:projects:create",
	"urn:neoncloud:projects:read",
	"urn:neoncloud:projects:update",
	"urn:neoncloud:projects:delete",
	"urn:neoncloud:orgs:create",
	"urn:neoncloud:orgs:read",
	"urn:neoncloud:orgs:update",
	"urn:neoncloud:orgs:delete",
	"urn:neoncloud:orgs:permission",
] as const;

const AUTH_TIMEOUT_SECONDS = 60;

export const defaultClientID = "neonctl";

export type AuthProps = {
	oauthHost: string;
	clientId: string;
	allowUnsafeTls?: boolean;
};

/** `terminal` is a dead grant. A network failure is not. */
export class AuthRefreshError extends Error {
	readonly terminal: boolean;
	readonly oauthError: string | undefined;
	readonly cause: unknown;

	constructor(
		message: string,
		options: { terminal: boolean; oauthError?: string; cause?: unknown },
	) {
		super(message);
		this.name = "AuthRefreshError";
		this.terminal = options.terminal;
		this.oauthError = options.oauthError;
		this.cause = options.cause;
	}
}

const DEAD_GRANT_ERRORS = new Set([
	"invalid_grant",
	"token_inactive",
	"invalid_token",
]);

export const classifyRefreshFailure = (err: unknown): AuthRefreshError => {
	const rejection = oauthRejection(err);
	if (rejection) {
		return new AuthRefreshError(
			`The Neon authorization server rejected the stored session: ${rejection.error}${
				rejection.description ? `: ${rejection.description}` : ""
			}`,
			{
				terminal: DEAD_GRANT_ERRORS.has(rejection.error),
				oauthError: rejection.error,
				cause: err,
			},
		);
	}

	return new AuthRefreshError(
		`Could not reach the Neon authorization server to refresh the stored session: ${
			err instanceof Error ? err.message : String(err)
		}`,
		{ terminal: false, cause: err },
	);
};

const oauthRejection = (
	err: unknown,
): { error: string; description?: string } | null => {
	if (err instanceof client.ResponseBodyError) {
		return {
			error: err.error,
			...(err.error_description
				? { description: err.error_description }
				: {}),
		};
	}

	if (err instanceof client.WWWAuthenticateChallengeError) {
		const challenge = err.cause.find(({ parameters }) => parameters.error);
		const error = challenge?.parameters.error;
		if (typeof error !== "string") return null;
		const description = challenge?.parameters.error_description;
		return {
			error,
			...(typeof description === "string" ? { description } : {}),
		};
	}

	return null;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Remote HTTP would send the refresh token in the clear. Loopback is for local test servers. */
const oauthExecute = (
	oauthHost: string,
	allowUnsafeTls?: boolean,
): (typeof client.allowInsecureRequests)[] | undefined => {
	if (allowUnsafeTls === true) {
		return [client.allowInsecureRequests];
	}
	try {
		const url = new URL(oauthHost);
		if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
			return [client.allowInsecureRequests];
		}
	} catch {
		return undefined;
	}
	return undefined;
};

export const refreshToken = async (
	{ oauthHost, clientId, allowUnsafeTls }: AuthProps,
	tokenSet: Pick<ExtendedTokenSet, "refresh_token">,
) => {
	const refresh = tokenSet.refresh_token;
	if (typeof refresh !== "string" || refresh === "") {
		throw new AuthRefreshError(
			"The stored credentials hold no refresh token.",
			{ terminal: true },
		);
	}

	log.debug("Discovering oauth server");
	const configuration = await client.discovery(
		new URL(oauthHost),
		clientId,
		{ token_endpoint_auth_method: "none" },
		client.None(),
		{
			timeout: SERVER_TIMEOUT,
			execute: oauthExecute(oauthHost, allowUnsafeTls),
		},
	);

	return await client.refreshTokenGrant(configuration, refresh);
};

/**
 * Invalidate a refresh token at the authorization server (RFC 7009).
 *
 * Best-effort by design, and it returns a boolean rather than throwing: the usual reason to
 * revoke is that a profile is being removed, and a revoke that fails — offline, token
 * already dead, server unreachable — must not leave the local entry stranded. Deleting the
 * file alone would only stop *us* using the token; this stops anyone.
 */
export const revokeToken = async (
	{ oauthHost, clientId, allowUnsafeTls }: AuthProps,
	tokenSet: ExtendedTokenSet,
): Promise<boolean> => {
	const token = tokenSet.refresh_token;
	if (typeof token !== "string" || token === "") return false;
	try {
		const configuration = await client.discovery(
			new URL(oauthHost),
			clientId,
			{ token_endpoint_auth_method: "none" },
			client.None(),
			{
				timeout: SERVER_TIMEOUT,
				execute: oauthExecute(oauthHost, allowUnsafeTls),
			},
		);
		await client.tokenRevocation(configuration, token, {
			token_type_hint: "refresh_token",
		});
		return true;
	} catch (err) {
		log.debug(
			"Token revocation failed: %s",
			err instanceof Error ? err.message : String(err),
		);
		return false;
	}
};

export const auth = async ({
	oauthHost,
	clientId,
	allowUnsafeTls,
}: AuthProps) => {
	log.debug("Discovering oauth server");
	const configuration = await client.discovery(
		new URL(oauthHost),
		clientId,
		{ token_endpoint_auth_method: "none" },
		client.None(),
		{
			timeout: SERVER_TIMEOUT,
			execute: oauthExecute(oauthHost, allowUnsafeTls),
		},
	);

	//
	// Start HTTP server and wait till /callback is hit
	//
	log.debug("Starting HTTP Server for callback");
	const server = createServer();
	server.listen(0, "127.0.0.1", function (this: typeof server) {
		log.debug(`Listening on port ${(this.address() as AddressInfo).port}`);
	});
	await new Promise((resolve) => server.once("listening", resolve));
	const listen_port = (server.address() as AddressInfo).port;

	// https://datatracker.ietf.org/doc/html/rfc6819#section-4.4.1.8
	const state = client.randomState();

	// we store the code_verifier in memory
	const codeVerifier = client.randomPKCECodeVerifier();

	const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

	return new Promise<ExtendedTokenSet>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(
				new Error(
					`Authentication timed out after ${AUTH_TIMEOUT_SECONDS} seconds`,
				),
			);
		}, AUTH_TIMEOUT_SECONDS * 1000);

		const onRequest = async (
			request: IncomingMessage,
			response: ServerResponse,
		) => {
			//
			// Wait for callback and follow oauth flow.
			//
			if (!request.url?.startsWith("/callback")) {
				response.writeHead(404);
				response.end();
				return;
			}

			// process the CORS preflight OPTIONS request
			if (request.method === "OPTIONS") {
				response.writeHead(200, {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST",
					"Access-Control-Allow-Headers": "Content-Type",
				});
				response.end();
				return;
			}

			log.debug(`Callback received: ${request.url}`);
			const tokenSet: client.TokenEndpointResponse =
				await client.authorizationCodeGrant(
					configuration,
					new URL(request.url, `http://127.0.0.1:${listen_port}`),
					{
						pkceCodeVerifier: codeVerifier,
						expectedState: state,
					},
				);

			response.writeHead(200, { "Content-Type": "text/html" });
			createReadStream(
				join(
					fileURLToPath(new URL(".", import.meta.url)),
					"./callback.html",
				),
			).pipe(response);

			clearTimeout(timer);
			const exp = new Date();
			exp.setSeconds(exp.getSeconds() + (tokenSet.expires_in ?? 0));
			resolve(extendTokenSet(tokenSet));
			server.close();
		};

		server.on("request", (req, res) => {
			void onRequest(req, res);
		});

		//
		// Open browser to let user authenticate
		//
		const scopes =
			clientId == defaultClientID
				? NEONCTL_SCOPES
				: ALWAYS_PRESENT_SCOPES;

		const authUrl = client.buildAuthorizationUrl(configuration, {
			scope: scopes.join(" "),
			state,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
			redirect_uri: REDIRECT_URI(listen_port),
		});

		log.info("Awaiting authentication in web browser.");
		log.info(`Auth Url: ${authUrl}`);

		open(authUrl.href).catch((err: unknown) => {
			const msg = `Failed to open web browser. Please copy & paste auth url to authenticate in browser.`;
			const typedErr = err && err instanceof Error ? err : undefined;
			sendError(typedErr || new Error(msg), matchErrorCode(msg));
			log.error(msg);
		});
	});
};
