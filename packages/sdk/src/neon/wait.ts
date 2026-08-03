import type { Client } from "../client/client/index.js";
import { getProjectOperation } from "../client/sdk.gen.js";
import type { Operation, OperationStatus } from "../client/types.gen.js";
import {
	createDeadline,
	type Deadline,
	delay,
	runBounded,
} from "./deadline.js";
import {
	NeonAbortError,
	type NeonError,
	NeonOperationError,
	NeonTimeoutError,
	toNeonError,
} from "./errors.js";
import { err, type NeonResult, ok } from "./result.js";

const SUCCESS: ReadonlySet<OperationStatus> = new Set(["finished", "skipped"]);
const FAILURE: ReadonlySet<OperationStatus> = new Set([
	"failed",
	"error",
	"cancelled",
]);

export interface WaitForOptions {
	/** How often to poll each pending operation. Default 1000ms. */
	pollIntervalMs?: number;
	/** Overall deadline before giving up. Default 300000ms (5 min). */
	timeoutMs?: number;
	signal?: AbortSignal;
}

/**
 * Why waiting stopped, with a message about readiness rather than about a request.
 * Returns `undefined` while the wait may continue.
 */
function readinessEnded(
	deadline: Deadline,
	timeoutMs: number,
	pending: number,
): NeonError | undefined {
	const source = deadline.source();
	if (source === "caller") {
		return new NeonAbortError(
			"Waiting for operations was aborted by its signal.",
		);
	}
	if (source === "timeout") {
		return new NeonTimeoutError(
			`Timed out after ${timeoutMs}ms waiting for ${pending} operation(s) to finish.`,
		);
	}
	return undefined;
}

/**
 * Poll the given operations until each reaches a terminal `finished`/`skipped` state.
 * Returns an error result carrying {@link NeonOperationError} if any operation ends in
 * `failed`/`error`/`cancelled`, {@link NeonTimeoutError} if the deadline is exceeded, or
 * {@link NeonAbortError} if the caller's signal fired.
 *
 * `timeoutMs` is a real deadline rather than a check between polls. Each poll runs under
 * it, so a request that hangs cannot outlast the budget, and the budget is re-examined
 * after every operation rather than once per round — a round polls each pending operation
 * in turn, so checking only at the top let a long round overrun the timeout arbitrarily.
 *
 * Composable: usable directly with operations obtained from the raw layer.
 */
export async function waitForOperations(
	client: Client,
	operations: readonly Operation[],
	options: WaitForOptions = {},
): Promise<NeonResult<void>> {
	const pollIntervalMs = options.pollIntervalMs ?? 1000;
	const timeoutMs = options.timeoutMs ?? 300_000;
	const deadline = createDeadline(timeoutMs, options.signal);

	try {
		// Track only operations that aren't already in a terminal state.
		let pending = operations.filter((op) => !SUCCESS.has(op.status));

		for (const op of pending) {
			if (FAILURE.has(op.status)) return err(operationFailed(op));
		}
		pending = pending.filter((op) => !FAILURE.has(op.status));

		while (pending.length > 0) {
			const ended = readinessEnded(deadline, timeoutMs, pending.length);
			if (ended) return err(ended);

			if (
				(await delay(pollIntervalMs, deadline.signal)) === "cancelled"
			) {
				return err(
					readinessEnded(deadline, timeoutMs, pending.length) ??
						new NeonAbortError(
							"Waiting for operations was aborted by its signal.",
						),
				);
			}

			const stillPending: Operation[] = [];
			// Counted from what is left rather than from the round's starting size, so a
			// timeout part-way through a round reports the operations actually outstanding.
			let remaining = pending.length;
			for (const op of pending) {
				const polled = await runBounded(deadline, () =>
					getProjectOperation({
						client,
						path: {
							project_id: op.project_id,
							operation_id: op.id,
						},
						throwOnError: false,
						signal: deadline.signal,
					}),
				);

				// Cancellation is read from the deadline before the response is
				// classified: an aborted poll comes back as a transport failure with no
				// response, which `toNeonError` would otherwise report as a network error.
				const stopped = readinessEnded(deadline, timeoutMs, remaining);
				if (stopped) return err(stopped);
				if (polled === undefined) {
					return err(toNeonError(undefined, undefined));
				}

				const { data, error, response } = polled;
				if (error || !data) return err(toNeonError(error, response));

				const current = data.operation;
				if (FAILURE.has(current.status)) {
					return err(operationFailed(current));
				}
				if (SUCCESS.has(current.status)) remaining -= 1;
				else stillPending.push(current);
			}
			pending = stillPending;
		}

		return ok(undefined);
	} finally {
		deadline.dispose();
	}
}

function operationFailed(op: Operation): NeonOperationError {
	const detail = op.error ? `: ${op.error}` : "";
	return new NeonOperationError(
		`Operation ${op.id} (${op.action}) ended with status "${op.status}"${detail}.`,
		{ operationId: op.id, status: op.status },
	);
}

/** Type guard: does a response body carry an `operations` array we can wait on? */
export function hasOperations(
	data: unknown,
): data is { operations: Operation[] } {
	return (
		typeof data === "object" &&
		data !== null &&
		"operations" in data &&
		Array.isArray(data.operations)
	);
}
