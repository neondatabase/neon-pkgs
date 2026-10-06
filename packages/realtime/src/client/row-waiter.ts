import type { LiveQuerySnapshot } from "./types.js";

interface PendingRowWait<Row> {
	readonly matches: (rows: readonly Row[]) => boolean;
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
	readonly timer?: ReturnType<typeof setTimeout>;
}
/** Owns materialized-row predicates independently of public listeners. */
export class RowWaiter<Row> {
	private readonly waiting = new Set<PendingRowWait<Row>>();
	private closed = false;

	constructor(private readonly snapshot: () => LiveQuerySnapshot<Row>) {}

	wait(
		matches: (rows: readonly Row[]) => boolean,
		timeout?: number,
	): Promise<void> {
		if (
			timeout !== undefined &&
			(!Number.isFinite(timeout) || timeout < 0)
		) {
			return Promise.reject(
				new Error(
					"Live-query row timeout must be a non-negative number",
				),
			);
		}
		if (this.closed) {
			return Promise.reject(
				new Error("Live-query subscription is closed"),
			);
		}

		return new Promise<void>((resolve, reject) => {
			const waiter: PendingRowWait<Row> = {
				matches,
				resolve,
				reject,
				timer:
					timeout === undefined
						? undefined
						: setTimeout(
								() =>
									this.fail(
										waiter,
										new Error(
											"Timed out waiting for live-query rows",
										),
									),
								timeout,
							),
			};
			this.waiting.add(waiter);
			this.inspect(waiter, this.snapshot());
		});
	}

	/** Inspect every pending predicate after an observable snapshot changes. */
	changed(snapshot: LiveQuerySnapshot<Row>): void {
		if (this.closed) return;
		for (const waiter of [...this.waiting]) this.inspect(waiter, snapshot);
	}

	/** Reject current waits while allowing future waits against a new baseline. */
	invalidate(error: Error): void {
		if (this.closed) return;
		this.rejectAll(error);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.rejectAll(new Error("Live-query subscription is closed"));
	}

	private inspect(
		waiter: PendingRowWait<Row>,
		snapshot: LiveQuerySnapshot<Row>,
	): void {
		if (!this.waiting.has(waiter)) return;
		try {
			if (snapshot.data !== undefined && waiter.matches(snapshot.data)) {
				this.succeed(waiter);
				return;
			}
		} catch (error) {
			this.fail(waiter, error);
			return;
		}

		if (snapshot.status === "error") this.fail(waiter, snapshot.error);
		else if (snapshot.status === "closed") {
			this.fail(waiter, new Error("Live-query subscription is closed"));
		}
	}

	private succeed(waiter: PendingRowWait<Row>): void {
		this.remove(waiter);
		waiter.resolve();
	}

	private fail(waiter: PendingRowWait<Row>, error: unknown): void {
		this.remove(waiter);
		waiter.reject(error);
	}

	private rejectAll(error: Error): void {
		for (const waiter of [...this.waiting]) this.fail(waiter, error);
	}

	private remove(waiter: PendingRowWait<Row>): void {
		if (!this.waiting.delete(waiter)) return;
		if (waiter.timer !== undefined) clearTimeout(waiter.timer);
	}
}
