import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

import {
	parseTriggerInvocation,
	TRIGGER_INVOCATION_ID_HEADER,
	type TriggerInvocation,
} from "./parse-trigger-invocation.js";

const PARSE_TRIGGER_MESSAGES = {
	missing_header: `Missing ${TRIGGER_INVOCATION_ID_HEADER} header`,
	invalid_body: "Invalid trigger payload",
	invocation_id_mismatch: "Invocation id mismatch",
} as const;

/**
 * Parses a Function Trigger delivery from a Hono context.
 *
 * Throws `HTTPException` (401 / 400) so the handler cannot proceed on a bad
 * delivery. Lives on the route rather than middleware: a `c.set` helper would
 * need a `Variables` generic and would type the payload on every route.
 */
export async function parseTrigger(c: Context): Promise<TriggerInvocation> {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		throw new HTTPException(400, { message: "Invalid JSON body" });
	}

	const parsed = parseTriggerInvocation({
		header: c.req.header(TRIGGER_INVOCATION_ID_HEADER),
		body,
	});
	if (!parsed.ok) {
		const status = parsed.error === "invalid_body" ? 400 : 401;
		throw new HTTPException(status, {
			message: PARSE_TRIGGER_MESSAGES[parsed.error],
		});
	}
	return parsed.invocation;
}
