import { cancelled, type Deadline, runBounded } from "./deadline.js";

/**
 * How a SQL transaction ended, as far as the client can tell. `rolled_back` is a
 * Postgres error (HTTP 400): nothing was committed. `uncertain` means the request may
 * have reached Postgres and committed: the response was lost, cut short, or not the
 * shape a committed batch returns.
 */
export type SqlTransactionOutcome =
	| { kind: "committed" }
	| {
			kind: "rolled_back";
			message: string | undefined;
			code: string | undefined;
			response: Response;
			body: unknown;
	  }
	| { kind: "uncertain"; reason: string; cause?: unknown };

/**
 * Run `statements` as one transaction over Neon's HTTP SQL endpoint, the protocol
 * `@neondatabase/serverless` uses: the endpoint host with its first label replaced by
 * `api`, and the connection string in a header.
 *
 * Not retried: a replayed batch can run twice. Redirects are refused because the
 * `Neon-Connection-String` header carries a password.
 */
export async function runSqlTransaction(input: {
	connectionString: string;
	statements: readonly string[];
	fetch: typeof fetch;
	deadline: Deadline;
}): Promise<SqlTransactionOutcome> {
	const { deadline } = input;
	let response: Response | undefined;
	try {
		response = await runBounded(deadline, () =>
			input.fetch(sqlEndpoint(input.connectionString), {
				method: "POST",
				headers: { "Neon-Connection-String": input.connectionString },
				body: JSON.stringify({
					queries: input.statements.map((query) => ({
						query,
						params: [],
					})),
				}),
				redirect: "error",
				signal: deadline.signal,
			}),
		);
	} catch (error) {
		return {
			kind: "uncertain",
			reason: "the SQL request failed before a response arrived",
			cause: cancelled(deadline) ?? error,
		};
	}
	if (response === undefined) {
		return {
			kind: "uncertain",
			reason: "the SQL request was cancelled",
			cause: cancelled(deadline),
		};
	}

	let body: unknown;
	try {
		body = await runBounded(deadline, () => response.json());
	} catch (error) {
		return {
			kind: "uncertain",
			reason: `the SQL endpoint returned HTTP ${response.status} with an unreadable body`,
			cause: error,
		};
	}

	if (response.status === 400) {
		return {
			kind: "rolled_back",
			...readPostgresError(body),
			response,
			body,
		};
	}
	if (!response.ok) {
		return {
			kind: "uncertain",
			reason: `the SQL endpoint returned HTTP ${response.status}`,
		};
	}
	const results =
		typeof body === "object" && body !== null && "results" in body
			? body.results
			: undefined;
	if (!Array.isArray(results) || results.length !== input.statements.length) {
		return {
			kind: "uncertain",
			reason: "the SQL endpoint returned a response without one result per statement",
		};
	}
	return { kind: "committed" };
}

function sqlEndpoint(connectionString: string): string {
	const host = new URL(connectionString).hostname;
	return `https://${host.replace(/^[^.]+\./, "api.")}/sql`;
}

function readPostgresError(body: unknown): {
	message: string | undefined;
	code: string | undefined;
} {
	if (typeof body !== "object" || body === null) {
		return { message: undefined, code: undefined };
	}
	return {
		message:
			"message" in body && typeof body.message === "string"
				? body.message
				: undefined,
		code:
			"code" in body && typeof body.code === "string"
				? body.code
				: undefined,
	};
}
