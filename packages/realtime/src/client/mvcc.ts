import type { MvccSnapshot } from "./protocol/messages.js";

/** Immutable visibility evidence for known committed transaction IDs. */
export interface ParsedMvccSnapshot {
	readonly xmin: bigint;
	readonly xmax: bigint;
	readonly xip: readonly bigint[];
	readonly isVisible: (txid: bigint) => boolean;
}

/** Parse structurally validated MVCC and check its cross-field invariants. */
export function parseMvccSnapshot(snapshot: MvccSnapshot): ParsedMvccSnapshot {
	const xmin = BigInt(snapshot.xmin);
	const xmax = BigInt(snapshot.xmax);
	if (xmin > xmax) throw new Error("MVCC xmin exceeds xmax");
	const xip = new Set<bigint>();
	for (const encoded of snapshot.xip) {
		const txid = BigInt(encoded);
		if (txid < xmin || txid >= xmax) {
			throw new Error("MVCC exclusion is outside [xmin, xmax)");
		}
		xip.add(txid);
	}
	return parsedSnapshot(xmin, xmax, xip);
}

/**
 * Retain the union of two applied proofs from the same database history.
 *
 * A capped proof can have a lower xmax than its predecessor. Start with the
 * wider proof and remove holes the other proof fills; this preserves every
 * earlier confirmation without retaining a growing history of snapshots.
 */
export function mergeMvccSnapshots(
	previous: ParsedMvccSnapshot,
	incoming: ParsedMvccSnapshot,
): ParsedMvccSnapshot {
	const [wider, other] =
		previous.xmax >= incoming.xmax
			? [previous, incoming]
			: [incoming, previous];
	const xmin = previous.xmin > incoming.xmin ? previous.xmin : incoming.xmin;
	const xip = wider.xip.filter((txid) => !other.isVisible(txid));
	if (xmin === wider.xmin && xip.length === wider.xip.length) return wider;
	return parsedSnapshot(xmin, wider.xmax, new Set(xip));
}

function parsedSnapshot(
	xmin: bigint,
	xmax: bigint,
	exclusions: ReadonlySet<bigint>,
): ParsedMvccSnapshot {
	return Object.freeze({
		xmin,
		xmax,
		xip: Object.freeze([...exclusions]),
		isVisible: (txid: bigint) =>
			txid < xmin || (txid < xmax && !exclusions.has(txid)),
	});
}
