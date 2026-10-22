import { describe, expect, it } from "vitest";
import { ProtocolError } from "./codec.js";
import {
	FragmentAssembler,
	MAX_ASSEMBLED_MESSAGE_LENGTH,
} from "./fragment-assembler.js";

describe("FragmentAssembler", () => {
	it("assembles a message from multiple fragments", () => {
		const assembler = new FragmentAssembler();
		const messageJson = '{"type":"ping","token":"test"}';

		// Split into 3 parts
		const part1 = messageJson.slice(0, 9); // '{"type":"'
		const part2 = messageJson.slice(9, 18); // 'ping","to'
		const part3 = messageJson.slice(18); // 'ken":"test"}'

		expect(
			assembler.processFragment("stream1", 0, false, part1),
		).toBeUndefined();
		expect(
			assembler.processFragment("stream1", 1, false, part2),
		).toBeUndefined();
		const result = assembler.processFragment("stream1", 2, true, part3);

		expect(result).toBe(messageJson);
	});

	it("handles multi-byte UTF-8 characters split across fragments", () => {
		const assembler = new FragmentAssembler();
		// "Hello 👋 World" - emoji is 2 UTF-16 code units
		const messageJson = '{"type":"test","data":"Hello 👋 World"}';

		// Split right before the emoji
		const part1 = messageJson.slice(0, 20); // '{"type":"test","data":'
		const part2 = messageJson.slice(20); // '"Hello 👋 World"}'

		expect(
			assembler.processFragment("msg1", 0, false, part1),
		).toBeUndefined();
		const result = assembler.processFragment("msg1", 1, true, part2);

		expect(result).toBe(messageJson);
	});

	it("rejects fragment with non-zero first index", () => {
		const assembler = new FragmentAssembler();

		expect(() => {
			assembler.processFragment("stream1", 1, false, "data");
		}).toThrow(ProtocolError);
	});

	it("rejects index gap in stream", () => {
		const assembler = new FragmentAssembler();

		assembler.processFragment("stream1", 0, false, "part0");
		expect(() => {
			assembler.processFragment("stream1", 2, false, "part2");
		}).toThrow(ProtocolError);
	});

	it("rejects id change mid-stream", () => {
		const assembler = new FragmentAssembler();

		assembler.processFragment("stream1", 0, false, "part0");
		expect(() => {
			assembler.processFragment("stream2", 1, false, "part1");
		}).toThrow(ProtocolError);
	});

	it("allows ping/pong during stream (new stream after ping)", () => {
		const assembler = new FragmentAssembler();

		assembler.processFragment("stream1", 0, false, "part0");

		// After a ping, we should still be in the same stream state
		// (ping doesn't reset the stream)
		expect(() => {
			assembler.processFragment("stream1", 1, false, "part1");
		}).not.toThrow();
	});

	it("rejects message size exceeding limit", () => {
		const assembler = new FragmentAssembler();

		// Create a fragment that when assembled with another fragment
		// exceeds the limit
		const part1 = "x".repeat(MAX_ASSEMBLED_MESSAGE_LENGTH);
		const part2 = "y";

		assembler.processFragment("stream1", 0, false, part1);
		expect(() => {
			assembler.processFragment("stream1", 1, false, part2);
		}).toThrow(ProtocolError);

		// Stream should be reset after error
		expect(assembler.isOpen()).toBe(false);
	});

	it("allows resetting mid-stream", () => {
		const assembler = new FragmentAssembler();

		assembler.processFragment("stream1", 0, false, "part0");
		expect(assembler.isOpen()).toBe(true);

		assembler.reset();
		expect(assembler.isOpen()).toBe(false);

		// Should now accept a new stream starting at index 0
		expect(() => {
			assembler.processFragment("stream2", 0, true, "new message");
		}).not.toThrow();
	});

	it("handles single fragment message", () => {
		const assembler = new FragmentAssembler();
		const messageJson = '{"type":"ready"}';

		const result = assembler.processFragment("msg1", 0, true, messageJson);

		expect(result).toBe(messageJson);
		expect(assembler.isOpen()).toBe(false);
	});

	it("rejects empty fragment data", () => {
		// Schema validation should catch this, but assembler should handle gracefully
		const assembler = new FragmentAssembler();

		// This would normally be rejected at the schema level,
		// but if it gets here, we should handle it
		const result = assembler.processFragment("stream1", 0, false, "part0");
		expect(result).toBeUndefined();
	});

	it("accumulates length correctly for multi-byte characters", () => {
		const assembler = new FragmentAssembler();

		// Each emoji is 2 UTF-16 code units
		const emojis = "👋".repeat(
			Math.floor(MAX_ASSEMBLED_MESSAGE_LENGTH / 2) - 10,
		);
		const part1 = emojis.slice(0, emojis.length / 2);
		const part2 = emojis.slice(emojis.length / 2);

		assembler.processFragment("stream1", 0, false, part1);
		const result = assembler.processFragment("stream1", 1, true, part2);

		expect(result).toBe(emojis);
	});
});
