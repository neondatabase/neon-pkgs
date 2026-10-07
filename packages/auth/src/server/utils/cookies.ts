import { parseCookies, parseSetCookieHeader } from "better-auth/cookies";
import { NEON_AUTH_COOKIE_PREFIX } from "../constants";

export interface ParsedCookie {
	name: string;
	value: string;
	maxAge?: number;
	expires?: Date;
	domain?: string;
	path?: string;
	secure?: boolean;
	httpOnly?: boolean;
	partitioned?: boolean;
	sameSite?: "strict" | "lax" | "none";
}

/**
 * Extract the Neon Auth cookies from the request headers.
 * Only returns cookies that start with the NEON_AUTH_COOKIE_PREFIX.
 *
 * @param headers - The request headers or cookie header string.
 * @returns The cookie string with all Neon Auth cookies (e.g., "name=value; name2=value2").
 */
export const extractNeonAuthCookies = (headers: Headers | string): string => {
	const cookieHeader =
		typeof headers === "string" ? headers : headers.get("cookie");
	if (!cookieHeader) return "";

	const parsedCookies = parseCookies(cookieHeader);
	const result: string[] = [];

	for (const [name, value] of parsedCookies.entries()) {
		if (name.startsWith(NEON_AUTH_COOKIE_PREFIX)) {
			result.push(`${name}=${value}`);
		}
	}

	return result.join("; ");
};

/**
 * Parses the `set-cookie` header from Neon Auth response into a list of cookies.
 *
 * @param setCookieHeader - The `set-cookie` header from Neon Auth response.
 * @returns The list of parsed cookies with their options.
 */
export const parseSetCookies = (setCookieHeader: string): ParsedCookie[] => {
	const parsedCookies = parseSetCookieHeader(setCookieHeader);
	const cookies: ParsedCookie[] = [];

	for (const entry of parsedCookies.entries()) {
		const [name, parsedCookie] = entry;
		cookies.push({
			name,
			value: decodeURIComponent(parsedCookie.value),
			path: parsedCookie.path,
			domain: parsedCookie.domain,
			maxAge: parsedCookie["max-age"] ?? parsedCookie.maxAge,
			// Surface `expires` so callers (e.g. session minting) can detect deletion
			// cookies by their past `Expires` attribute, not just `Max-Age=0`.
			// See #161 review feedback (Andras FIX 2, correctness).
			expires: parsedCookie.expires,
			httpOnly: parsedCookie.httponly ?? true,
			secure: parsedCookie.secure ?? true,
			sameSite: parsedCookie.samesite ?? "lax",
			partitioned: parsedCookie.partitioned,
		});
	}

	return cookies;
};

/**
 * Serializes a parsed cookie object back into a Set-Cookie header string
 *
 * @param cookie - The parsed cookie object
 * @returns The Set-Cookie header string
 */
export const serializeSetCookie = (cookie: ParsedCookie): string => {
	// Start with name=value
	let result = `${cookie.name}=${encodeURIComponent(cookie.value)}`;

	// Add attributes in conventional order
	if (cookie.path) result += `; Path=${cookie.path}`;
	if (cookie.domain) result += `; Domain=${cookie.domain}`;
	if (cookie.maxAge !== undefined) result += `; Max-Age=${cookie.maxAge}`;
	if (cookie.expires) result += `; Expires=${cookie.expires.toUTCString()}`;
	if (cookie.httpOnly) result += "; HttpOnly";
	if (cookie.secure) result += "; Secure";
	if (cookie.sameSite) {
		// Capitalize first letter (lax -> Lax, strict -> Strict, none -> None)
		const sameSite =
			cookie.sameSite.charAt(0).toUpperCase() + cookie.sameSite.slice(1);
		result += `; SameSite=${sameSite}`;
	}
	if (cookie.partitioned) result += "; Partitioned";

	return result;
};

/**
 * Extract a single cookie value by name from a cookie header string
 *
 * @param cookieString - The cookie header string (e.g., "name=value; name2=value2")
 * @param name - The cookie name to extract
 * @returns The cookie value or null if not found
 */
export const parseCookieValue = (
	cookieString: string,
	name: string,
): string | null => {
	if (!cookieString) return null;

	const parsedCookies = parseCookies(cookieString);
	return parsedCookies.get(name) ?? null;
};
