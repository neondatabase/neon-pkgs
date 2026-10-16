import type { IncomingMessage, ServerResponse } from "node:http";

import { sendWebResponse, toWebRequest } from "./node-http";

export type FetchHandler = (request: Request) => Response | Promise<Response>;
export type NodeNext = (err?: unknown) => void;
export type NodeMiddleware = (
	req: IncomingMessage,
	res: ServerResponse,
	next: NodeNext,
) => void;

/** Runs `step` on the converted request; a returned Response is sent, `undefined` calls `next`. Errors go to `next(err)`. */
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

/** Adapts a Request->Response handler (such as `client.handlers.login`) to a plain `node:http` listener. */
export function toNodeHandler(
	handler: FetchHandler,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
	return async (req, res) =>
		sendWebResponse(res, await handler(toWebRequest(req)));
}
