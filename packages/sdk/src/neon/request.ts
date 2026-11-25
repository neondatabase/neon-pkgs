import type { CallOptions, RequestContext } from "./context.js";
import { NeonClientError } from "./errors.js";
import { err, finalize, type NeonResult, ok } from "./result.js";

export type ApiRequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiRequest {
	method: ApiRequestMethod;
	/**
	 * Relative to the client's `baseUrl`, with every placeholder filled in, such as
	 * `/projects/old-flower-123/branches`. Query parameters go in `query`.
	 */
	path: string;
	query?: Record<string, string | number | boolean>;
	/** Sent as JSON. */
	body?: unknown;
}

const PCHARS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%/]+$/;

/**
 * The decoded segments of an API path, or a {@link NeonClientError} saying why the path
 * is refused. Policy checks on a path must read these segments: `fetch` and the server
 * decode percent-escapes, so the raw string is not the path that gets routed.
 */
export function parseApiPath(path: string): NeonResult<string[]> {
	const refuse = (reason: string) =>
		err<string[]>(
			new NeonClientError(
				`Invalid API path ${JSON.stringify(path)}: ${reason}`,
			),
		);
	if (!path.startsWith("/")) {
		return refuse('it must start with "/", e.g. /projects.');
	}
	if (/[{}]/.test(path)) {
		return refuse("fill in every {placeholder} with a real value.");
	}
	if (/[?#]/.test(path)) {
		return refuse("pass query parameters in query, not in the path.");
	}
	if (!PCHARS.test(path)) {
		return refuse(
			"it may only contain URL path characters; percent-encode anything else.",
		);
	}
	const segments: string[] = [];
	for (const raw of path.slice(1).split("/")) {
		let segment: string;
		try {
			segment = decodeURIComponent(raw);
		} catch {
			return refuse(`"${raw}" is not valid percent-encoding.`);
		}
		if (segment === "") {
			return refuse("it has an empty segment.");
		}
		if (segment === "." || segment === "..") {
			return refuse('"." and ".." segments are not allowed.');
		}
		if (/[/\\]/.test(segment)) {
			return refuse("an encoded slash or backslash is not allowed.");
		}
		segments.push(segment);
	}
	return ok(segments);
}

const parseBody = (text: string, response: Response | undefined): unknown => {
	if (text === "") return null;
	const contentType = response?.headers.get("Content-Type") ?? "";
	return /\bjson\b/i.test(contentType) ? JSON.parse(text) : text;
};

/**
 * One request to any Neon API route. The body is parsed JSON, the text of a non-JSON
 * body, or `null` for an empty one. Never polls operations.
 */
export async function apiRequest(
	ctx: RequestContext,
	request: ApiRequest,
	opts?: CallOptions,
): Promise<unknown> {
	const parsed = parseApiPath(request.path);
	if (parsed.error) {
		return finalize(parsed, ctx.shouldThrow(opts));
	}
	return ctx.run(
		{ ...opts, waitForReadiness: false },
		async (client, signal) => {
			const result = await client.request({
				method: request.method,
				url: request.path,
				query: request.query,
				body: request.body,
				...(request.body === undefined
					? {}
					: { headers: { "Content-Type": "application/json" } }),
				signal,
				parseAs: "text",
				redirect: "error",
				security: [{ scheme: "bearer", type: "http" }],
			});
			if (result.error !== undefined || typeof result.data !== "string") {
				return result;
			}
			try {
				return {
					...result,
					data: parseBody(result.data, result.response),
				};
			} catch (cause) {
				return {
					...result,
					data: undefined,
					error: new NeonClientError(
						`The Neon API answered ${request.method} ${request.path} with a body that is not valid JSON.`,
						{ cause },
					),
				};
			}
		},
		(data: unknown) => data,
	);
}
