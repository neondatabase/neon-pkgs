import type { Client } from "../client/client/index.js";
import { getProjectOperation } from "../client/sdk.gen.js";
import type { Operation, OperationStatus } from "../client/types.gen.js";
import { NeonOperationError, NeonTimeoutError, toNeonError } from "./errors.js";
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

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const id = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(id);
				reject(signal.reason);
			},
			{ once: true },
		);
	});

/**
 * Poll the given operations until each reaches a terminal `finished`/`skipped` state.
 * Returns an error result carrying {@link NeonOperationError} if any operation ends in
 * `failed`/`error`/`cancelled`, or {@link NeonTimeoutError} if the deadline is exceeded.
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
	const deadline = Date.now() + timeoutMs;

	// Track only operations that aren't already in a terminal state.
	let pending = operations.filter((op) => !SUCCESS.has(op.status));

	for (const op of pending) {
		if (FAILURE.has(op.status)) return err(operationFailed(op));
	}
	pending = pending.filter((op) => !FAILURE.has(op.status));

	while (pending.length > 0) {
		if (Date.now() > deadline) {
			return err(
				new NeonTimeoutError(
					`Timed out after ${timeoutMs}ms waiting for ${pending.length} operation(s) to finish.`,
				),
			);
		}
		await sleep(pollIntervalMs, options.signal);

		const stillPending: Operation[] = [];
		for (const op of pending) {
			const { data, error, response } = await getProjectOperation({
				client,
				path: { project_id: op.project_id, operation_id: op.id },
				throwOnError: false,
				signal: options.signal,
			});
			if (error || !data) return err(toNeonError(error, response));

			const current = data.operation;
			if (FAILURE.has(current.status))
				return err(operationFailed(current));
			if (!SUCCESS.has(current.status)) stillPending.push(current);
		}
		pending = stillPending;
	}

	return ok(undefined);
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
