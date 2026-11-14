import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import legacyV2Schema from "../../../schema/legacy/realtime-protocol-v2.schema.json";
import {
	base64Candidates,
	base64CellPattern,
} from "./base64-cell.test-helpers.js";
import {
	decodeServerFrame,
	decodeServerMessage,
	encodeClientMessage,
	ProtocolError,
	REALTIME_SUBPROTOCOL_V2,
	REALTIME_SUBPROTOCOL_V3,
} from "./index.js";
import type { ClientMessage } from "./messages.js";
import orderedFixtures from "./schema/ordered-changes.fixtures.json";
import fixtures from "./schema/realtime-protocol.fixtures.json";
import segmentRoundFixtures from "./schema/segment-rounds.fixtures.json";

const CLIENT_TYPES = new Set([
	"client_info",
	"subscribe",
	"renew",
	"unsubscribe",
	"ping",
	"pong",
]);
const SERVER_TYPES = new Set([
	"ready",
	"progress",
	"subscribed",
	"subscribe_rejected",
	"renewed",
	"unsubscribed",
	"baseline_sync_start",
	"baseline_sync_batch",
	"baseline_sync_end",
	"open",
	"keyed_results",
	"segments_pending",
	"reset_required",
	"commit",
	"subscription_error",
	"connection_error",
	"client_warning",
	"ping",
	"pong",
]);
const ROW_KEY = "a".repeat(64);

const decode = (text: string) =>
	decodeServerMessage(text, REALTIME_SUBPROTOCOL_V3);
const decodeFrame = (text: string) =>
	decodeServerFrame(text, REALTIME_SUBPROTOCOL_V3);
const FOUR_MIB = 4 * 1024 * 1024;

function rejectServerMessage(value: unknown): void {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	expect(() => decode(text)).toThrow(ProtocolError);
}

function batchWithBase64Cell(base64: string): object {
	return {
		type: "baseline_sync_batch",
		live_id: "9",
		epoch: "1",
		baseline_sync_attempt: "1",
		round: "1",
		index: 0,
		rows: [{ row_key: ROW_KEY, values: [{ base64 }] }],
	};
}

// True when the frame decodes; only a ProtocolError means "rejected".
function decodesCleanly(frame: string): boolean {
	try {
		decode(frame);
		return true;
	} catch (error) {
		if (error instanceof ProtocolError) return false;
		throw error;
	}
}

describe("Realtime JSON codec", () => {
	it("requires a canonical move predecessor and rejects unsupported rollout fields", () => {
		for (const fixture of orderedFixtures.valid)
			expect(decode(JSON.stringify(fixture))).toEqual(fixture);
		for (const fixture of orderedFixtures.invalid)
			rejectServerMessage(fixture);
		expect(() =>
			encodeClientMessage({
				type: "subscribe",
				request_id: "1",
				authorization: "token",
				supports_moves: true,
			} as ClientMessage),
		).toThrow(ProtocolError);
		rejectServerMessage({ type: "ready", supports_moves: true });
		rejectServerMessage({ type: "mode_ack", mode: "ordered" });
		rejectServerMessage({ type: "abort", publication_id: "p" });
	});

	it("decodes every valid server fixture", () => {
		const validServerFixtures = [
			...fixtures.valid,
			...segmentRoundFixtures.valid,
		].filter(({ type }) => SERVER_TYPES.has(type));
		expect(new Set(validServerFixtures.map(({ type }) => type))).toEqual(
			SERVER_TYPES,
		);
		for (const fixture of validServerFixtures) {
			expect(() => decode(JSON.stringify(fixture))).not.toThrow();
		}
	});

	it("decodes a v2 session exactly as the v2 schema accepts, in the v3 shape", () => {
		// The frozen v2 schema is the oracle for the v2 decoder, which shares no
		// validation code with it.
		const ajv = new Ajv2020({
			discriminator: true,
			strict: true,
			validateFormats: false,
		}).addSchema(legacyV2Schema);
		const v2Schema = ajv.getSchema(
			`${legacyV2Schema.$id}#/$defs/serverMessage`,
		);
		if (!v2Schema) throw new Error("v2 schema has no server messages");
		const decodesAsV2 = (value: unknown) => {
			try {
				decodeServerMessage(
					JSON.stringify(value),
					REALTIME_SUBPROTOCOL_V2,
				);
				return true;
			} catch (error) {
				if (error instanceof ProtocolError) return false;
				throw error;
			}
		};
		const strip = (value: Record<string, unknown>) => {
			const {
				round: _round,
				scope: _scope,
				covered: _covered,
				...rest
			} = value;
			return rest;
		};
		const candidates = [
			...fixtures.valid,
			...fixtures.invalid,
			...orderedFixtures.valid,
			...orderedFixtures.invalid,
			...segmentRoundFixtures.valid,
			...segmentRoundFixtures.invalid,
		].flatMap((fixture) => [
			fixture,
			strip(fixture as Record<string, unknown>),
		]);
		let accepted = 0;
		for (const candidate of candidates) {
			const expected = v2Schema(candidate);
			if (expected) accepted += 1;
			expect(decodesAsV2(candidate), JSON.stringify(candidate)).toBe(
				expected,
			);
		}
		expect(accepted).toBeGreaterThan(20);

		const start = decodeServerMessage(
			JSON.stringify(
				strip(
					fixtures.valid.find(
						({ type }) => type === "baseline_sync_start",
					) as Record<string, unknown>,
				),
			),
			REALTIME_SUBPROTOCOL_V2,
		);
		expect(start).toMatchObject({
			type: "baseline_sync_start",
			round: "1",
			scope: { kind: "all" },
		});
		expect(start).not.toHaveProperty("covered");
	});

	it("rejects malformed and noncanonical server messages", () => {
		for (const fixture of fixtures.invalid) {
			if (
				!CLIENT_TYPES.has(fixture.type) ||
				SERVER_TYPES.has(fixture.type)
			) {
				expect(
					() => decode(JSON.stringify(fixture)),
					JSON.stringify(fixture),
				).toThrow(ProtocolError);
			}
		}
		expect(() => decode("not json")).toThrow(ProtocolError);
		expect(() =>
			decode(
				JSON.stringify({
					type: "subscription_error",
					live_id: "18446744073709551616",
					code: "protocol_error",
					message: "bad",
				}),
			),
		).toThrow(ProtocolError);
		expect(() =>
			decode(
				JSON.stringify({
					type: "baseline_sync_batch",
					live_id: "1",
					epoch: "1",
					baseline_sync_attempt: "1",
					round: "1",
					index: 0,
					rows: [
						{
							row_key: "a".repeat(64),
							values: [{ base64: "Bx==" }],
						},
					],
				}),
			),
		).toThrow(ProtocolError);
	});

	it("rejects duplicate object keys before JSON parsing can erase them", () => {
		expect(() => decode('{"type":"ready","type":"ready"}')).toThrow(
			ProtocolError,
		);
		expect(() => decode('{"type":"ready","\\u0074ype":"ready"}')).toThrow(
			ProtocolError,
		);
		expect(() =>
			decode(
				'{"type":"commit","publication_id":"p","body_count":0,"frontier":{"lsn":"0/0","lsn":"0/0"}}',
			),
		).toThrow(ProtocolError);
	});

	it("allows repeated keys in separate objects and punctuation inside values", () => {
		expect(() =>
			decode(
				JSON.stringify({
					type: "baseline_sync_batch",
					live_id: "9",
					epoch: "1",
					baseline_sync_attempt: "1",
					round: "1",
					index: 0,
					rows: [
						{ row_key: ROW_KEY, values: ['"key":{[', "\\"] },
						{ row_key: ROW_KEY, values: ["雪", null] },
					],
				}),
			),
		).not.toThrow();
	});

	it("rejects unknown, inherited, and client-only message types", () => {
		for (const type of [
			"unknown",
			"constructor",
			"__proto__",
			"toString",
		]) {
			rejectServerMessage({ type });
		}
		rejectServerMessage({ type: "hello", database: "app" });
		rejectServerMessage({
			type: "subscribe",
			request_id: "1",
			authorization: "token",
		});
	});

	it("enforces the complete uint64 range from the schema", () => {
		const keyedResults = {
			type: "keyed_results",
			publication_id: "p",
			index: 0,
			txids: ["18446744073709551615"],
			targets: [],
			changes: [],
		};
		const baselineSyncStart = {
			type: "baseline_sync_start",
			live_id: "9",
			epoch: "1",
			baseline_sync_attempt: "1",
			round: "1",
			scope: { kind: "all" },
			mvcc: {
				xmin: "1",
				xmax: "18446744073709551615",
				xip: ["18446744073709551614"],
			},
		};
		expect(() => decode(JSON.stringify(keyedResults))).not.toThrow();
		expect(() => decode(JSON.stringify(baselineSyncStart))).not.toThrow();
		for (const invalid of [
			"0",
			"01",
			"18446744073709551616",
			"9".repeat(21),
		]) {
			rejectServerMessage({ ...keyedResults, txids: [invalid] });
			rejectServerMessage({
				...baselineSyncStart,
				mvcc: { ...baselineSyncStart.mvcc, xip: [invalid] },
			});
		}
	});

	it("parses immutable MVCC evidence once for progress frames", () => {
		const message = {
			type: "progress",
			mvcc: { xmin: "100", xmax: "110", xip: ["103"] },
		};
		const frame = decodeFrame(JSON.stringify(message));
		expect(frame.message).toEqual(message);
		expect(frame.mvcc).toMatchObject({
			xmin: 100n,
			xmax: 110n,
			xip: [103n],
		});
		expect(frame.mvcc?.isVisible(103n)).toBe(false);
		expect(frame.mvcc?.isVisible(109n)).toBe(true);
		expect(Object.isFrozen(frame.mvcc)).toBe(true);
	});

	it("validates MVCC semantics identically for baselines and progress", () => {
		const envelopes = [
			{ type: "progress" },
			{
				type: "baseline_sync_start",
				live_id: "1",
				epoch: "1",
				baseline_sync_attempt: "1",
				round: "1",
				scope: { kind: "all" },
			},
		];
		for (const envelope of envelopes) {
			for (const mvcc of [
				{ xmin: "20", xmax: "10", xip: [] },
				{ xmin: "10", xmax: "20", xip: ["9"] },
				{ xmin: "10", xmax: "20", xip: ["20"] },
			]) {
				expect(() =>
					decode(JSON.stringify({ ...envelope, mvcc })),
				).toThrow(/MVCC/);
			}
			for (const invalid of ["0", "01", "18446744073709551616"]) {
				for (const mvcc of [
					{ xmin: invalid, xmax: "20", xip: [] },
					{ xmin: "10", xmax: invalid, xip: [] },
					{ xmin: "10", xmax: "20", xip: [invalid] },
				]) {
					rejectServerMessage({ ...envelope, mvcc });
				}
			}
			expect(() =>
				decode(
					JSON.stringify({
						...envelope,
						mvcc: {
							xmin: "18446744073709551615",
							xmax: "18446744073709551615",
							xip: [],
						},
					}),
				),
			).not.toThrow();
		}
	});

	it("requires canonical base64 cells, including zero padding bits", () => {
		const snapshot = (base64: string) => ({
			type: "baseline_sync_batch",
			live_id: "9",
			epoch: "1",
			baseline_sync_attempt: "1",
			round: "1",
			index: 0,
			rows: [{ row_key: ROW_KEY, values: [{ base64 }] }],
		});
		for (const base64 of ["", "AA==", "AAA=", "/w==", "////"]) {
			expect(() =>
				decode(JSON.stringify(snapshot(base64))),
			).not.toThrow();
		}
		for (const base64 of ["AB==", "AAB=", "/x==", "not canonical"]) {
			expect(() => decode(JSON.stringify(snapshot(base64)))).toThrow(
				"is not canonical base64",
			);
		}
	});

	it("decodes a 4 MiB bytea cell, the Realtime row limit", () => {
		const base64 = Buffer.alloc(FOUR_MIB, 0x41).toString("base64");
		expect(base64).toHaveLength(5_592_408);
		const batch = batchWithBase64Cell(base64);
		expect(decode(JSON.stringify(batch))).toEqual(batch);
	});

	it("decodes base64 cells past the length where V8's RegExp overflows", () => {
		// 4,500,004 characters, well past the ~4.47M-character overflow point.
		const base64 = Buffer.alloc(3_375_003, 0x41).toString("base64");
		expect(base64).toHaveLength(4_500_004);
		const batch = batchWithBase64Cell(base64);
		expect(decode(JSON.stringify(batch))).toEqual(batch);
	});

	it("still rejects noncanonical base64 cells at the same size", () => {
		const canonical = Buffer.alloc(3_375_003, 0x41).toString("base64");
		const middle = 2_000_000;
		for (const invalid of [
			`${canonical.slice(0, -4)}QUJ=`,
			`${canonical.slice(0, middle)}*${canonical.slice(middle + 1)}`,
			`${canonical.slice(0, middle)}QQ==${canonical.slice(middle + 4)}`,
			`${canonical}Q`,
		]) {
			expect(() =>
				decode(JSON.stringify(batchWithBase64Cell(invalid))),
			).toThrow("is not canonical base64");
		}
	});

	it("accepts exactly the base64 cells the schema pattern accepts", () => {
		const pattern = new RegExp(base64CellPattern, "u");
		fc.assert(
			fc.property(base64Candidates, (base64) => {
				expect(
					decodesCleanly(JSON.stringify(batchWithBase64Cell(base64))),
				).toBe(pattern.test(base64));
			}),
			{ numRuns: 500 },
		);
	});

	it("rejects malformed nested rows, cells, changes, and fields", () => {
		rejectServerMessage({
			type: "baseline_sync_batch",
			live_id: "9",
			epoch: "1",
			baseline_sync_attempt: "1",
			round: "1",
			index: 0,
			rows: [{ row_key: ROW_KEY, values: [], extra: true }],
		});
		rejectServerMessage({
			type: "baseline_sync_batch",
			live_id: "9",
			epoch: "1",
			baseline_sync_attempt: "1",
			round: "1",
			index: 0,
			rows: [{ row_key: "zz", values: [] }],
		});
		rejectServerMessage({
			type: "baseline_sync_batch",
			live_id: "9",
			epoch: "1",
			baseline_sync_attempt: "1",
			round: "1",
			index: 0,
			rows: [{ row_key: ROW_KEY, values: [123] }],
		});
		rejectServerMessage({
			type: "keyed_results",
			publication_id: "p",
			index: 0,
			txids: ["1"],
			targets: [],
			changes: [{ op: "unknown", row_key: ROW_KEY }],
		});
	});

	it("applies protocol limits to UTF-8 bytes", () => {
		expect(() =>
			decode(
				JSON.stringify({
					type: "open",
					publication_id: "é".repeat(32),
				}),
			),
		).not.toThrow();
		expect(() =>
			decode(
				JSON.stringify({
					type: "open",
					publication_id: "é".repeat(33),
				}),
			),
		).toThrow(ProtocolError);
		expect(() =>
			decode(
				JSON.stringify({
					...segmentRoundFixtures.valid[0],
					publication_id: "é".repeat(33),
				}),
			),
		).toThrow(ProtocolError);
		expect(() =>
			decode(
				JSON.stringify({
					type: "pong",
					token: "😀".repeat(17),
				}),
			),
		).toThrow(ProtocolError);
	});

	it("accepts server messages larger than the former 1 MiB limit", () => {
		expect(() =>
			decode(
				JSON.stringify({
					type: "connection_error",
					code: "protocol_error",
					message: "x".repeat(1024 * 1024),
				}),
			),
		).not.toThrow();
	});

	it("keeps the production validator generated from the authoritative schema", () => {
		const generator = fileURLToPath(
			new URL("../../../scripts/generate-protocol.mjs", import.meta.url),
		);
		expect(() =>
			execFileSync(process.execPath, [generator, "--check"]),
		).not.toThrow();
	});

	it("serializes every client command with wire field names", () => {
		const messages: ClientMessage[] = [
			{
				type: "client_info",
				metadata:
					'{"sdk":"javascript","release_line":"0.2","version":"0.2.0"}',
			},
			{ type: "subscribe", request_id: "1", authorization: "token" },
			{ type: "renew", live_id: "1", authorization: "token" },
			{ type: "unsubscribe", live_id: "1" },
			{ type: "ping", token: "heartbeat-1" },
			{ type: "pong", token: "heartbeat-1" },
		];
		expect(
			messages.map((message) => JSON.parse(encodeClientMessage(message))),
		).toEqual(
			fixtures.valid
				.filter(({ type }) => CLIENT_TYPES.has(type))
				.slice(0, 6),
		);
	});

	it("rejects invalid outbound identifiers and bounds", () => {
		expect(() =>
			encodeClientMessage({
				type: "subscribe",
				request_id: "01",
				authorization: "token",
			}),
		).toThrow(ProtocolError);
	});
});
