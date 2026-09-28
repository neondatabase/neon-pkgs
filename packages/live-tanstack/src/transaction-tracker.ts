const DEFAULT_TXID_TIMEOUT_MS = 5_000;
const MAX_SEEN_TXIDS = 1_000;

interface TransactionWaiter {
	readonly resolve: (matched: boolean) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

export class TransactionTracker {
	private readonly recent = new Set<string>();
	private readonly recentOrder: string[] = [];
	private readonly waiting = new Map<string, Set<TransactionWaiter>>();
	private closed = false;

	wait = async (
		txid: string,
		timeout = DEFAULT_TXID_TIMEOUT_MS,
	): Promise<boolean> => {
		const normalized = normalizeTxid(txid);
		if (!Number.isFinite(timeout) || timeout < 0) {
			throw new Error(
				"Neon Live transaction timeout must be a non-negative number",
			);
		}
		if (this.closed) {
			throw new Error("Neon Live collection is cleaned up");
		}
		if (this.recent.has(normalized)) return true;

		return new Promise<boolean>((resolve, reject) => {
			const waiter: TransactionWaiter = {
				resolve,
				reject,
				timer: setTimeout(() => {
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
			while (this.recentOrder.length > MAX_SEEN_TXIDS) {
				const oldest = this.recentOrder.shift();
				if (oldest !== undefined) this.recent.delete(oldest);
			}
		}
		const waiters = this.waiting.get(normalized);
		if (!waiters) return;
		this.waiting.delete(normalized);
		for (const waiter of waiters) {
			clearTimeout(waiter.timer);
			waiter.resolve(true);
		}
	}

	open(): void {
		this.closed = false;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		const error = new Error("Neon Live collection was cleaned up");
		for (const waiters of this.waiting.values()) {
			for (const waiter of waiters) {
				clearTimeout(waiter.timer);
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
