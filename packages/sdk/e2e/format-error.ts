import type { NeonErrorUnion } from "../src/neon/errors.js";

/**
 * One line for logs and tests. The API's `message` can be the unclassified
 * fallback "unknown error"; kind, status, and request id are what you act on.
 */
export function formatNeonError(error: NeonErrorUnion): string {
	const extra = extraNeonErrorBits(error);
	return extra.length === 0
		? error.message
		: `${error.message} (${extra.join(", ")})`;
}

function extraNeonErrorBits(error: NeonErrorUnion): string[] {
	switch (error.kind) {
		case "api":
		case "not_found":
		case "auth":
		case "rate_limit": {
			const bits = [error.kind, `status ${error.status}`];
			if (error.code) bits.push(`code ${error.code}`);
			if (error.requestId) bits.push(`request ${error.requestId}`);
			return bits;
		}
		case "operation":
			return [error.kind, `operation ${error.operationId}`, error.status];
		case "timeout":
			return [error.kind, error.source, `${error.timeoutMs}ms`];
		case "aborted":
			return [error.kind];
		case "network":
			return [error.kind, error.reason];
		case "client":
			return [error.kind];
		default: {
			const _exhaustive: never = error;
			void _exhaustive;
			return [];
		}
	}
}
