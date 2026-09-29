const MAX_RECENT_TXIDS = 1_000;

interface TransactionWaiter {
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
	readonly timer?: ReturnType<typeof setTimeout>;
}

export class TransactionTracker {
	private readonly recent = new Set<string>();
	private readonly recentOrder: string[] = [];
	private readonly waiting = new Map<string, Set<TransactionWaiter>>();
	private closed = false;

	wait = async (txid: string, timeout?: number): Promise<void> => {
		const normalized = normalizeTxid(txid);
		if (
			timeout !== undefined &&
			(!Number.isFinite(timeout) || timeout < 0)
		) {
			throw new Error(
				"Neon Live transaction timeout must be a non-negative number",
			);
		}
		if (this.closed) throw new Error("Neon Live subscription is closed");
		if (this.recent.has(normalized)) return;

		return new Promise<void>((resolve, reject) => {
			const waiter: TransactionWaiter = {
				resolve,
				reject,
				timer:
					timeout === undefined
						? undefined
						: setTimeout(() => {
								this.remove(normalized, waiter);
								reject(
									new Error(
										`Timed out waiting for Neon Live transaction ${normalized}`,
									),
								);
							}, timeout),
			};
			const waiters = this.waiting.get(normalized) ?? new Set();
			waiters.add(waiter);
			this.waiting.set(normalized, waiters);
		});
	};

	seen(txid: string): void {
		if (this.closed) return;
		const normalized = normalizeTxid(txid);
		if (!this.recent.has(normalized)) {
			this.recent.add(normalized);
			this.recentOrder.push(normalized);
			while (this.recentOrder.length > MAX_RECENT_TXIDS) {
				const oldest = this.recentOrder.shift();
				if (oldest !== undefined) this.recent.delete(oldest);
			}
		}
		const waiters = this.waiting.get(normalized);
		if (!waiters) return;
		this.waiting.delete(normalized);
		for (const waiter of waiters) {
			if (waiter.timer !== undefined) clearTimeout(waiter.timer);
			waiter.resolve();
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		const error = new Error("Neon Live subscription is closed");
		for (const waiters of this.waiting.values()) {
			for (const waiter of waiters) {
				if (waiter.timer !== undefined) clearTimeout(waiter.timer);
				waiter.reject(error);
			}
		}
		this.waiting.clear();
		this.recent.clear();
		this.recentOrder.length = 0;
	}

	private remove(txid: string, waiter: TransactionWaiter): void {
		const waiters = this.waiting.get(txid);
		if (!waiters) return;
		waiters.delete(waiter);
		if (waiters.size === 0) this.waiting.delete(txid);
	}
}

function normalizeTxid(txid: string): string {
	if (typeof txid !== "string" || !/^\d+$/.test(txid)) {
		throw new Error("Neon Live transaction ID must be a decimal string");
	}
	const parsed = BigInt(txid);
	if (parsed > 18_446_744_073_709_551_615n) {
		throw new Error("Neon Live transaction ID exceeds uint64");
	}
	return parsed.toString();
}
