import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
	decodeServerFrame,
	decodeServerMessage,
	encodeClientMessage,
	ProtocolError,
} from "./index.js";
import type { ClientMessage } from "./messages.js";
import fixtures from "./schema/neon-live-protocol-v1.fixtures.json";

const CLIENT_TYPES = new Set([
	"subscribe",
	"renew",
	"unsubscribe",
	"ping",
	"pong",
]);
const SERVER_TYPES = new Set([
	"ready",
	"subscribed",
	"subscribe_rejected",
	"renewed",
	"unsubscribed",
	"baseline_sync_start",
	"baseline_sync_batch",
	"baseline_sync_end",
	"open",
	"keyed_results",
	"reset_required",
	"commit",
	"subscription_error",
	"connection_error",
	"ping",
	"pong",
]);
const ROW_KEY = "a".repeat(64);

function rejectServerMessage(value: unknown): void {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	expect(() => decodeServerMessage(text)).toThrow(ProtocolError);
}

describe("Neon Live v1 JSON codec", () => {
	it("decodes every valid server fixture", () => {
		const validServerFixtures = fixtures.valid.filter(({ type }) =>
			SERVER_TYPES.has(type),
		);
		expect(new Set(validServerFixtures.map(({ type }) => type))).toEqual(
			SERVER_TYPES,
		);
		for (const fixture of validServerFixtures) {
			expect(() =>
				decodeServerMessage(JSON.stringify(fixture)),
			).not.toThrow();
		}
	});

	it("rejects malformed and noncanonical server messages", () => {
		for (const fixture of fixtures.invalid) {
			if (
				!CLIENT_TYPES.has(fixture.type) ||
				SERVER_TYPES.has(fixture.type)
			) {
				expect(
					() => decodeServerMessage(JSON.stringify(fixture)),
					JSON.stringify(fixture),
				).toThrow(ProtocolError);
			}
		}
		expect(() => decodeServerMessage("not json")).toThrow(ProtocolError);
		expect(() =>
			decodeServerMessage(
				JSON.stringify({
					type: "subscription_error",
					live_id: "18446744073709551616",
					code: "protocol_error",
					message: "bad",
				}),
			),
		).toThrow(ProtocolError);
		expect(() =>
			decodeServerMessage(
				JSON.stringify({
					type: "baseline_sync_batch",
					live_id: "1",
					epoch: "1",
					baseline_sync_attempt: "1",
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
		expect(() =>
			decodeServerMessage('{"type":"ready","type":"ready"}'),
		).toThrow(ProtocolError);
		expect(() =>
			decodeServerMessage('{"type":"ready","\\u0074ype":"ready"}'),
		).toThrow(ProtocolError);
		expect(() =>
			decodeServerMessage(
				'{"type":"commit","publication_id":"p","body_count":0,"frontier":{"lsn":"0/0","lsn":"0/0"}}',
			),
		).toThrow(ProtocolError);
	});

	it("allows repeated keys in separate objects and punctuation inside values", () => {
		expect(() =>
			decodeServerMessage(
				JSON.stringify({
					type: "baseline_sync_batch",
					live_id: "9",
					epoch: "1",
					baseline_sync_attempt: "1",
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
			mvcc: {
				xmin: "1",
				xmax: "18446744073709551615",
				xip: ["18446744073709551614"],
			},
		};
		expect(() =>
			decodeServerMessage(JSON.stringify(keyedResults)),
		).not.toThrow();
		expect(() =>
			decodeServerMessage(JSON.stringify(baselineSyncStart)),
		).not.toThrow();
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

	it("requires canonical base64 cells, including zero padding bits", () => {
		const snapshot = (base64: string) => ({
			type: "baseline_sync_batch",
			live_id: "9",
			epoch: "1",
			baseline_sync_attempt: "1",
			index: 0,
			rows: [{ row_key: ROW_KEY, values: [{ base64 }] }],
		});
		for (const base64 of ["", "AA==", "AAA=", "/w==", "////"]) {
			expect(() =>
				decodeServerMessage(JSON.stringify(snapshot(base64))),
			).not.toThrow();
		}
		for (const base64 of ["AB==", "AAB=", "/x==", "not canonical"]) {
			expect(() =>
				decodeServerMessage(JSON.stringify(snapshot(base64))),
			).toThrow("is not canonical base64");
		}
	});

	it("rejects malformed nested rows, cells, changes, and fields", () => {
		rejectServerMessage({
			type: "baseline_sync_batch",
			live_id: "9",
			epoch: "1",
			baseline_sync_attempt: "1",
			index: 0,
			rows: [{ row_key: ROW_KEY, values: [], extra: true }],
		});
		rejectServerMessage({
			type: "baseline_sync_batch",
			live_id: "9",
			epoch: "1",
			baseline_sync_attempt: "1",
			index: 0,
			rows: [{ row_key: "zz", values: [] }],
		});
		rejectServerMessage({
			type: "baseline_sync_batch",
			live_id: "9",
			epoch: "1",
			baseline_sync_attempt: "1",
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
			decodeServerMessage(
				JSON.stringify({
					type: "open",
					publication_id: "é".repeat(32),
				}),
			),
		).not.toThrow();
		expect(() =>
			decodeServerMessage(
				JSON.stringify({
					type: "open",
					publication_id: "é".repeat(33),
				}),
			),
		).toThrow(ProtocolError);
		expect(() =>
			decodeServerMessage(
				JSON.stringify({
					type: "pong",
					token: "😀".repeat(17),
				}),
			),
		).toThrow(ProtocolError);
		expect(() =>
			decodeServerMessage(
				JSON.stringify({
					type: "connection_error",
					code: "protocol_error",
					message: "x".repeat(1024 * 1024),
				}),
			),
		).toThrow(ProtocolError);
	});

	it("keeps the production validator generated from the authoritative schema", () => {
		const generator = fileURLToPath(
			new URL("../../../scripts/generate-protocol.mjs", import.meta.url),
		);
		expect(() =>
			execFileSync(process.execPath, [generator, "--check"]),
		).not.toThrow();
	});

	it("reports the exact wire size for downstream staging accounting", () => {
		const text = JSON.stringify({ type: "pong", token: "é" });
		expect(decodeServerFrame(text)).toMatchObject({
			message: { type: "pong", token: "é" },
			byteLength: new TextEncoder().encode(text).byteLength,
		});
	});

	it("serializes every client command with wire field names", () => {
		const messages: ClientMessage[] = [
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
				.slice(0, 5),
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
