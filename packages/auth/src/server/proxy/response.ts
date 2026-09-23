import { parseSetCookies, serializeSetCookie } from "@/server/utils/cookies";
import type { SessionCookieConfig } from "../config";
import type { ResolvedNeonAuthLogging } from "../logger";
import { mintSessionDataFromResponse } from "../session/minting";

// Allowlist of response headers proxied from upstream Neon Auth to the client.
// Hop-by-hop / framing headers (`connection`, `transfer-encoding`,
// `content-length`) are intentionally excluded: the runtime sets framing
// itself, and a forwarded stale `content-length` corrupts a re-encoded body.
// See #161 review feedback (Andras FIX 4, correctness nit).
const RESPONSE_HEADERS_ALLOWLIST = [
	"content-type",
	"content-encoding",
	"date",
	"set-cookie",
	"set-auth-jwt",
	"set-auth-token",
	"x-neon-ret-request-id",
];

/**
 * Handles responses from upstream Neon Auth server
 * - Proxies allowed headers to client
 * - Mints session data cookie if session token is present
 *
 * @param response - Response from upstream Neon Auth server
 * @param baseUrl - Base URL of Neon Auth server
 * @param cookieConfig - Session cookie configuration
 * @returns New Response with proxied headers and session data cookie
 */
export const handleAuthResponse = async (
	response: Response,
	baseUrl: string,
	cookieConfig: SessionCookieConfig,
	log?: ResolvedNeonAuthLogging,
) => {
	const responseHeaders = prepareResponseHeaders(response, cookieConfig);

	// Mint session data cookie from upstream response
	const sessionDataCookie = await mintSessionDataFromResponse(
		response.headers,
		baseUrl,
		cookieConfig,
		log,
	);
	if (sessionDataCookie) {
		responseHeaders.append("Set-Cookie", sessionDataCookie);
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaders,
	});
};

const prepareResponseHeaders = (
	response: Response,
	cookieConfig: SessionCookieConfig,
) => {
	const headers = new Headers();
	const effectiveSameSite = cookieConfig.sameSite ?? "lax";
	const { domain } = cookieConfig;
	for (const header of RESPONSE_HEADERS_ALLOWLIST) {
		// Special handling for set-cookie: HTTP allows multiple Set-Cookie headers
		if (header === "set-cookie") {
			const cookies = response.headers.getSetCookie();
			for (const cookieHeader of cookies) {
				// Always sanitize upstream cookie flags before forwarding to the browser:
				// - Strip Partitioned: Safari does not send Partitioned cookies on top-level navigations,
				//   which breaks the OAuth challenge exchange when the callback hits a middleware route.
				//   The flag is also only meaningful for third-party contexts; proxied cookies are first-party.
				// - Apply configured SameSite (default lax): upstream may send SameSite=None with Partitioned.
				// Domain assignment is the only other conditional step.
				const parsedCookies = parseSetCookies(cookieHeader);
				for (const parsedCookie of parsedCookies) {
					parsedCookie.partitioned = undefined;
					parsedCookie.sameSite = effectiveSameSite;
					// Always force Secure on forwarded cookies, matching the minting
					// path (`session/minting.ts` hardcodes `secure: true`) and the
					// documented "Secure is always applied" contract. With
					// `SameSite=None`, a missing `Secure` makes the browser drop the
					// cookie entirely. See #161 review feedback (Andras FIX 1, security).
					parsedCookie.secure = true;
					if (domain) {
						parsedCookie.domain = domain;
					}
					headers.append(
						"Set-Cookie",
						serializeSetCookie(parsedCookie),
					);
				}
			}
		} else {
			const value = response.headers.get(header);
			if (value) {
				headers.set(header, value);
			}
		}
	}
	return headers;
};
