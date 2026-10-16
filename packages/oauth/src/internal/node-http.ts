// node:http <-> Web Request/Response conversion shared by the node and express adapters.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** `body: false` for requests whose stream a framework may already have consumed (e.g. behind a body parser). */
export function toWebRequest(
	req: IncomingMessage & { originalUrl?: string },
	opts: { body?: boolean } = {},
): Request {
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (Array.isArray(value))
			for (const v of value) headers.append(name, v);
		else if (value !== undefined) headers.set(name, value);
	}
	const hasBody =
		opts.body !== false && req.method !== "GET" && req.method !== "HEAD";
	return new Request(
		new URL(
			req.originalUrl ?? req.url ?? "/",
			`http://${req.headers.host ?? "localhost"}`,
		),
		{
			method: req.method,
			headers,
			body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
			// Required by undici whenever a request has a streaming body.
			duplex: "half",
		} as RequestInit,
	);
}

export async function sendWebResponse(
	res: ServerResponse,
	response: Response,
): Promise<void> {
	// `Headers` folds repeated Set-Cookie into one value; getSetCookie() keeps them separate.
	const out: Record<string, string | string[]> = {};
	response.headers.forEach((value, name) => {
		if (name !== "set-cookie") out[name] = value;
	});
	const cookies = response.headers.getSetCookie();
	if (cookies.length > 0) out["set-cookie"] = cookies;
	res.writeHead(response.status, out);
	if (!response.body) {
		res.end();
		return;
	}
	try {
		await pipeline(Readable.fromWeb(response.body as never), res);
	} catch {
		// Headers are already sent: a failed body or a client that went away can only end the connection.
		res.destroy();
	}
}
