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
 * Builds `node:http` middleware from a function over a Web `Request`; use it to write your own
 * Node-style adapter. `nodeBearerAuth` and `nodeOAuthClient` are built on it.
 *
 * A `Response` returned by `step` is sent, `undefined` calls `next()`, and a rejection of its
 * promise goes to `next(err)`. An error thrown synchronously, while building the `Request` or in
 * `step` itself, is not caught. The `Request` carries headers and URL only, no body, so it works
 * behind a body parser.
 *
 * @param step Receives the Web `Request` and the original `IncomingMessage`.
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
 * Adapts a Web-standard handler (`Request` in, `Response` out), such as `client.handlers.login`,
 * to a plain `node:http` listener `(req, res)`. The request body is passed through.
 */
export function toNodeHandler(
	handler: FetchHandler,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
	return async (req, res) =>
		sendWebResponse(res, await handler(toWebRequest(req)));
}
