import { describe, expect, test } from "vitest";

import { isEventStreamContentType, readAskSse } from "./ask_sse.js";

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const part of parts) {
				controller.enqueue(encoder.encode(part));
			}
			controller.close();
		},
	});
}

async function collect(parts: string[]) {
	const events = [];
	for await (const event of readAskSse(streamOf(parts))) {
		events.push(event);
	}
	return events;
}

describe("isEventStreamContentType", () => {
	test("matches text/event-stream with parameters", () => {
		expect(isEventStreamContentType("text/event-stream")).toBe(true);
		expect(
			isEventStreamContentType("text/event-stream; charset=utf-8"),
		).toBe(true);
		expect(isEventStreamContentType("application/json")).toBe(false);
		expect(
			isEventStreamContentType("application/json; charset=utf-8"),
		).toBe(false);
		expect(isEventStreamContentType(undefined)).toBe(false);
	});
});

describe("readAskSse", () => {
	test("parses status, text, and done across fragmented chunks", async () => {
		expect(
			await collect([
				'event: status\ndata: {"message":"Thinking"}\n\n',
				"event: te",
				'xt\ndata: {"text":"Hello"}\n\n',
				'event: text\ndata: {"text":" world"}\n\n',
				"event: done\ndata: {}\n\n",
			]),
		).toEqual([
			{ type: "status", message: "Thinking" },
			{ type: "text", text: "Hello" },
			{ type: "text", text: " world" },
			{ type: "done" },
		]);
	});

	test("parses CRLF and ignores ping heartbeats", async () => {
		expect(
			await collect([
				'event: status\r\ndata: {"message":"Thinking"}\r\n\r\n',
				"event: ping\r\ndata: \r\n\r\n",
				'event: text\r\ndata: {"text":"ok"}\r\n\r\n',
				"event: done\r\ndata: {}\r\n\r\n",
			]),
		).toEqual([
			{ type: "status", message: "Thinking" },
			{ type: "text", text: "ok" },
			{ type: "done" },
		]);
	});

	test("stops on error and redacts empty error text", async () => {
		expect(
			await collect([
				'event: text\ndata: {"text":"partial"}\n\n',
				'event: error\ndata: {"error":"The assistant failed."}\n\n',
				'event: text\ndata: {"text":"after"}\n\n',
			]),
		).toEqual([
			{ type: "text", text: "partial" },
			{ type: "error", error: "The assistant failed." },
		]);
	});

	test("decodes UTF-8 split across chunks", async () => {
		const json = '{"text":"é"}';
		const encoded = new TextEncoder().encode(
			`event: text\ndata: ${json}\n\nevent: done\ndata: {}\n\n`,
		);
		const splitAt = encoded.indexOf(0xc3) + 1;
		const first = encoded.slice(0, splitAt);
		const second = encoded.slice(splitAt);
		const events = [];
		for await (const event of readAskSse(
			new ReadableStream({
				start(controller) {
					controller.enqueue(first);
					controller.enqueue(second);
					controller.close();
				},
			}),
		)) {
			events.push(event);
		}
		expect(events).toEqual([{ type: "text", text: "é" }, { type: "done" }]);
	});
});
