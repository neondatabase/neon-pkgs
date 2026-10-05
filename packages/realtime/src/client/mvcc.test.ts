import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { mergeMvccSnapshots, parseMvccSnapshot } from "./mvcc.js";

const generatedSnapshot = fc
	.record({
		lower: fc.integer({ min: 1, max: 40 }),
		upper: fc.integer({ min: 1, max: 40 }),
		exclusions: fc.uniqueArray(fc.integer({ min: 1, max: 40 })),
	})
	.map(({ lower, upper, exclusions }) => {
		const xmin = Math.min(lower, upper);
		const xmax = Math.max(lower, upper);
		return parseMvccSnapshot({
			xmin: String(xmin),
			xmax: String(xmax),
			xip: exclusions
				.filter((txid) => txid >= xmin && txid < xmax)
				.map(String),
		});
	});

describe("MVCC visibility evidence", () => {
	it("retains immutable bounds and exclusions with exact uint64 precision", () => {
		const wire = {
			xmin: "18446744073709551612",
			xmax: "18446744073709551615",
			xip: ["18446744073709551613"],
		};
		const snapshot = parseMvccSnapshot(wire);
		wire.xip.length = 0;
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.xip)).toBe(true);
		expect(snapshot.xmin).toBe(18_446_744_073_709_551_612n);
		expect(snapshot.xmax).toBe(18_446_744_073_709_551_615n);
		expect(snapshot.xip).toEqual([18_446_744_073_709_551_613n]);
		expect(snapshot.isVisible(18_446_744_073_709_551_611n)).toBe(true);
		expect(snapshot.isVisible(18_446_744_073_709_551_612n)).toBe(true);
		expect(snapshot.isVisible(18_446_744_073_709_551_613n)).toBe(false);
		expect(snapshot.isVisible(18_446_744_073_709_551_614n)).toBe(true);
		expect(snapshot.isVisible(18_446_744_073_709_551_615n)).toBe(false);
	});

	it("accepts a contiguous frontier with equal bounds", () => {
		const snapshot = parseMvccSnapshot({ xmin: "10", xmax: "10", xip: [] });
		expect(snapshot.isVisible(9n)).toBe(true);
		expect(snapshot.isVisible(10n)).toBe(false);
	});

	it("rejects inconsistent bounds and exclusions", () => {
		expect(() =>
			parseMvccSnapshot({ xmin: "20", xmax: "10", xip: [] }),
		).toThrow("MVCC xmin exceeds xmax");
		for (const txid of ["9", "20", "21"]) {
			expect(() =>
				parseMvccSnapshot({ xmin: "10", xmax: "20", xip: [txid] }),
			).toThrow("MVCC exclusion is outside [xmin, xmax)");
		}
	});

	it("fills earlier holes without losing evidence above a later cutoff", () => {
		const earlier = parseMvccSnapshot({
			xmin: "100",
			xmax: "200",
			xip: ["103", "150"],
		});
		const later = parseMvccSnapshot({
			xmin: "104",
			xmax: "110",
			xip: ["105"],
		});
		const merged = mergeMvccSnapshots(earlier, later);
		expect(merged.xmin).toBe(104n);
		expect(merged.xmax).toBe(200n);
		expect(merged.xip).toEqual([150n]);
		expect(merged.isVisible(103n)).toBe(true);
		expect(merged.isVisible(105n)).toBe(true);
		expect(merged.isVisible(150n)).toBe(false);
		expect(merged.isVisible(199n)).toBe(true);
		expect(earlier.xip).toEqual([103n, 150n]);
	});

	it("merges arbitrary proof histories into their exact union with bounded exclusions", () => {
		fc.assert(
			fc.property(
				fc.array(generatedSnapshot, { minLength: 1, maxLength: 20 }),
				(snapshots) => {
					const merged = snapshots.reduce(mergeMvccSnapshots);
					expect(merged.xip.length).toBeLessThanOrEqual(
						Math.max(
							...snapshots.map((snapshot) => snapshot.xip.length),
						),
					);
					for (let txid = 1n; txid <= 41n; txid++) {
						expect(merged.isVisible(txid)).toBe(
							snapshots.some((snapshot) =>
								snapshot.isVisible(txid),
							),
						);
					}
					for (const txid of merged.xip) {
						expect(txid >= merged.xmin && txid < merged.xmax).toBe(
							true,
						);
					}
				},
			),
			{ numRuns: 300 },
		);
	});

	it("never loses visibility when full proofs are followed by safe prefix truncations", () => {
		fc.assert(
			fc.property(
				generatedSnapshot,
				fc.nat({ max: 40 }),
				(full, count) => {
					const exclusions = [...full.xip].sort((left, right) =>
						left < right ? -1 : left > right ? 1 : 0,
					);
					const cutoff = exclusions[count];
					if (cutoff === undefined) return;
					const truncated = parseMvccSnapshot({
						xmin: full.xmin.toString(),
						xmax: cutoff.toString(),
						xip: exclusions.slice(0, count).map(String),
					});
					const merged = mergeMvccSnapshots(full, truncated);
					for (let txid = 1n; txid <= 41n; txid++) {
						expect(merged.isVisible(txid)).toBe(
							full.isVisible(txid),
						);
						if (truncated.isVisible(txid))
							expect(full.isVisible(txid)).toBe(true);
					}
				},
			),
			{ numRuns: 300 },
		);
	});
});
