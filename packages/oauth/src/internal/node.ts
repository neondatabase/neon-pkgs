import type { IncomingMessage, ServerResponse } from "node:http";

import { sendWebResponse, toWebRequest } from "./node-http";

/** A handler in the Web `Request` -> `Response` shape, such as `client.handlers.login`. */
export type FetchHandler = (request: Request) => Response | Promise<Response>;
/** The `next` callback of `node:http`-style middleware; pass an error to hand it to the framework. */
export type NodeNext = (err?: unknown) => void;
/** Connect/Express-style middleware: `(req, res, next)`. */
export type NodeMiddleware = (
	req: IncomingMessage,
	res: ServerResponse,
	next: NodeNext,
) => void;

/**
 * Builds `node:http` middleware from a function over a Web `Request`: a returned `Response` is
 * sent, `undefined` calls `next()`, and a thrown error goes to `next(err)`. The request carries
 * headers and URL only, no body, so it works behind a body parser. Use it to write your own
 * Node-style adapter; `nodeBearerAuth` and `nodeOAuthClient` are built on it.
 */
export function nodeMiddleware(
	step: (
		request: Request,
		req: IncomingMessage,
	) => Promise<Response | undefined> | Response | undefined,
): NodeMiddleware {
	return (req, res, next) => {
		// Headers and URL only: a framework body parser may have consumed the stream already.
		Promise.resolve(step(toWebRequest(req, { body: false }), req)).then(
			(response) => (response ? sendWebResponse(res, response) : next()),
			next,
		);
	};
}

/**
 * Adapts a Web `Request` -> `Response` handler (such as `client.handlers.login`) to a plain
 * `node:http` listener `(req, res)`, e.g. `createServer(toNodeHandler(oauth.client.handlers.login))`.
 * Unlike `nodeMiddleware`, the request body is passed through.
 */
export function toNodeHandler(
	handler: FetchHandler,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
	return async (req, res) =>
		sendWebResponse(res, await handler(toWebRequest(req)));
}
