import {
	mergeMvccSnapshots,
	type ParsedMvccSnapshot,
	parseMvccSnapshot,
} from "./mvcc.js";
import type { MvccSnapshot } from "./protocol/messages.js";

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
	private visibility?: ParsedMvccSnapshot;
	private closed = false;
	private closeError?: Error;

	wait = async (txid: string, timeout?: number): Promise<void> => {
		const normalized = normalizeTxid(txid);
		if (
			timeout !== undefined &&
			(!Number.isFinite(timeout) || timeout < 0)
		) {
			throw new Error(
				"Live-query transaction timeout must be a non-negative number",
			);
		}
		if (this.closed) {
			throw (
				this.closeError ??
				new Error("Live-query subscription is closed")
			);
		}
		if (
			this.recent.has(normalized.text) ||
			this.visibility?.isVisible(normalized.value)
		)
			return;

		return new Promise<void>((resolve, reject) => {
			const waiter: TransactionWaiter = {
				resolve,
				reject,
				timer:
					timeout === undefined
						? undefined
						: setTimeout(() => {
								this.remove(normalized.text, waiter);
								reject(
									new Error(
										`Timed out waiting for live-query transaction ${normalized.text}`,
									),
								);
							}, timeout),
			};
			const waiters = this.waiting.get(normalized.text) ?? new Set();
			waiters.add(waiter);
			this.waiting.set(normalized.text, waiters);
		});
	};

	seen(txid: string): void {
		if (this.closed) return;
		const normalized = normalizeTxid(txid).text;
		if (!this.recent.has(normalized)) {
			this.recent.add(normalized);
			this.recentOrder.push(normalized);
			while (this.recentOrder.length > MAX_RECENT_TXIDS) {
				const oldest = this.recentOrder.shift();
				if (oldest !== undefined) this.recent.delete(oldest);
			}
		}
		this.resolve(normalized);
	}

	/** Record an installed snapshot and resolve every visible wait. */
	applySnapshot(snapshot: MvccSnapshot): void {
		if (this.closed) return;
		this.applyProgress(parseMvccSnapshot(snapshot));
	}

	/** Record progress only after every covered change has been installed. */
	applyProgress(snapshot: ParsedMvccSnapshot): void {
		if (this.closed) return;
		this.visibility = this.visibility
			? mergeMvccSnapshots(this.visibility, snapshot)
			: snapshot;
		for (const txid of this.waiting.keys()) {
			if (this.visibility.isVisible(BigInt(txid))) {
				this.resolve(txid);
			}
		}
	}

	close(error = new Error("Live-query subscription is closed")): void {
		if (this.closed) return;
		this.closed = true;
		this.closeError = error;
		for (const waiters of this.waiting.values()) {
			for (const waiter of waiters) {
				if (waiter.timer !== undefined) clearTimeout(waiter.timer);
				waiter.reject(error);
			}
		}
		this.waiting.clear();
		this.recent.clear();
		this.recentOrder.length = 0;
		this.visibility = undefined;
	}

	private remove(txid: string, waiter: TransactionWaiter): void {
		const waiters = this.waiting.get(txid);
		if (!waiters) return;
		waiters.delete(waiter);
		if (waiters.size === 0) this.waiting.delete(txid);
	}

	private resolve(txid: string): void {
		const waiters = this.waiting.get(txid);
		if (!waiters) return;
		this.waiting.delete(txid);
		for (const waiter of waiters) {
			if (waiter.timer !== undefined) clearTimeout(waiter.timer);
			waiter.resolve();
		}
	}
}

interface ParsedTxid {
	readonly text: string;
	readonly value: bigint;
}

function normalizeTxid(txid: string): ParsedTxid {
	if (typeof txid !== "string" || !/^\d+$/.test(txid)) {
		throw new Error("Live-query transaction ID must be a decimal string");
	}
	const parsed = BigInt(txid);
	if (parsed > 18_446_744_073_709_551_615n) {
		throw new Error("Live-query transaction ID exceeds uint64");
	}
	return { text: parsed.toString(), value: parsed };
}
