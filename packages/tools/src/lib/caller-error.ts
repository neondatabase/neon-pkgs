import { NeonClientError } from "@neon/sdk";

/**
 * A `NeonClientError` a tool raises for a mistake in the call or in the
 * caller's own resources: a missing page or table, an extension that is not
 * installed, a read-only refusal. `@neon/tools/effect` keeps the tool span ok
 * for it; any other `NeonClientError`, such as a malformed response, fails it.
 *
 * It keeps the name `NeonClientError`, which `@neon/effect` matches on and
 * callers already see.
 */
export class NeonToolCallerError extends NeonClientError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "NeonClientError";
	}
}
