import type { ResolvedNeonAuthLogging } from "@/server/logger";
import { classifyFetchFailure } from "@/server/network-error";
import { extractNeonAuthCookies } from "@/server/utils/cookies";

const PROXY_HEADERS = [
	"user-agent",
	"authorization",
	"referer",
	"content-type",
];

/**
 * Proxy header constant - indicates request went through Neon Auth middleware/handler
 * This is framework-agnostic and can be used by any server framework
 */
export const NEON_AUTH_HEADER_MIDDLEWARE_NAME = "x-neon-auth-middleware";

function safeAuthHost(baseUrl: string): string | undefined {
	try {
		return new URL(baseUrl).host;
	} catch {
		return undefined;
	}
}

/**
 * Handles proxying authentication requests to the upstream Neon Auth server
 *
 * @param baseUrl - Base URL of the Neon Auth server
 * @param request - Standard Web API Request object
 * @param path - API path to proxy to (e.g., 'get-session', 'sign-in')
 * @param log - Optional resolved logging sink
 * @returns Response from upstream server or error response
 */
export const handleAuthRequest = async (
	baseUrl: string,
	request: Request,
	path: string,
	log?: ResolvedNeonAuthLogging,
) => {
	const headers = prepareRequestHeaders(request);
	const body = await parseRequestBody(request);

	try {
		const upstreamURL = getUpstreamURL(baseUrl, path, {
			originalUrl: new URL(request.url),
		});
		const response = await fetch(upstreamURL.toString(), {
			method: request.method,
			headers: headers,
			body: body,
		});

		const host = safeAuthHost(baseUrl);
		if (response.ok) {
			log?.debug("[neon-auth] Upstream fetch completed", {
				component: "proxy",
				proxyPath: path,
				status: response.status,
				host,
			});
		} else if (response.status >= 500) {
			log?.warn("[neon-auth] Upstream HTTP error", {
				component: "proxy",
				proxyPath: path,
				status: response.status,
				statusText: response.statusText,
				host,
			});
		} else {
			log?.info("[neon-auth] Upstream HTTP non-2xx", {
				component: "proxy",
				proxyPath: path,
				status: response.status,
				statusText: response.statusText,
				host,
			});
		}

		return response;
	} catch (error) {
		const classified = classifyFetchFailure(error);

		if (classified.kind === "transport") {
			log?.warn("[neon-auth] Upstream fetch failed", {
				component: "proxy",
				proxyPath: path,
				code: classified.code,
				detail: classified.detail,
				host: safeAuthHost(baseUrl),
			});

			return Response.json(
				{
					error: classified.clientMessage,
					code: classified.code,
				},
				{
					status: 502,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		log?.error("[neon-auth] Unexpected proxy error", {
			component: "proxy",
			proxyPath: path,
			detail: classified.detail,
			host: safeAuthHost(baseUrl),
		});

		return Response.json(
			{
				error: classified.clientMessage,
				code: "INTERNAL_ERROR",
			},
			{ status: 500, headers: { "Content-Type": "application/json" } },
		);
	}
};

/**
 * Constructs the upstream URL for proxying to Neon Auth server
 *
 * @param baseUrl - Base URL of the Neon Auth server
 * @param path - API path (e.g., 'get-session')
 * @param options - Options including original URL for preserving query params
 * @returns Constructed upstream URL
 */
export const getUpstreamURL = (
	baseUrl: string,
	path: string,
	{
		originalUrl,
	}: {
		originalUrl?: URL;
	},
) => {
	const url = new URL(`${baseUrl}/${path}`);
	if (originalUrl) {
		url.search = originalUrl.search;
		return url;
	}
	return url;
};

const prepareRequestHeaders = (request: Request) => {
	const headers = new Headers();

	for (const header of PROXY_HEADERS) {
		const value = request.headers.get(header);
		if (value) {
			headers.set(header, value);
		}
	}
	headers.set("Origin", getOrigin(request));
	headers.set("Cookie", extractNeonAuthCookies(request.headers));
	headers.set(NEON_AUTH_HEADER_MIDDLEWARE_NAME, "true");
	return headers;
};

// Get the origin from the request headers or the url
const getOrigin = (request: Request) => {
	return (
		request.headers.get("origin") ||
		request.headers.get("referer")?.split("/").slice(0, 3).join("/") ||
		new URL(request.url).origin
	);
};

const parseRequestBody = async (request: Request) => {
	if (request.body) {
		return request.text();
	}

	return;
};
