import type { ContinuityCursor as WireContinuityCursor } from "./protocol/messages.js";

interface AppliedContinuityCursor {
	readonly history: string;
	lsn: bigint;
}

/** Tracks the newest database-history position installed by one subscription. */
export class ContinuityTracker {
	private cursor?: AppliedContinuityCursor;

	/**
	 * Install a replacement baseline position.
	 *
	 * Returns `false` only when an earlier installed position cannot be an
	 * ancestor of the replacement baseline.
	 */
	installBaseline(cursor: WireContinuityCursor): boolean {
		const lsn = parsePgLsn(cursor.lsn);
		const current = this.cursor;
		const continuous =
			current === undefined ||
			(current.history === cursor.history && lsn >= current.lsn);
		this.cursor = { history: cursor.history, lsn };
		return continuous;
	}

	/** Advance within the currently installed history after an ordered commit. */
	advance(lsn: string): void {
		const current = this.cursor;
		if (!current) return;
		const parsed = parsePgLsn(lsn);
		if (parsed > current.lsn) current.lsn = parsed;
	}
}

function parsePgLsn(value: string): bigint {
	const [upper, lower] = value.split("/");
	if (upper === undefined || lower === undefined) {
		throw new Error("Invalid PostgreSQL LSN");
	}
	return (BigInt(`0x${upper}`) << 32n) | BigInt(`0x${lower}`);
}
