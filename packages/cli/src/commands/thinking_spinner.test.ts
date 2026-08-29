import { Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createThinkingSpinner } from "./thinking_spinner.js";

afterEach(() => {
	vi.useRealTimers();
});

function capture() {
	const chunks: string[] = [];
	const out = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(String(chunk));
			callback();
		},
	});
	return { chunks, out };
}

describe("createThinkingSpinner", () => {
	test("paints a TTY line, updates it, and erases on stop", () => {
		vi.useFakeTimers();
		const { chunks, out } = capture();
		const spinner = createThinkingSpinner({ out, isTty: true });
		spinner.start();
		expect(chunks.join("")).toMatch(/Thinking/);
		spinner.setMessage("Searching Neon docs");
		expect(chunks.join("")).toMatch(/Searching Neon docs/);
		vi.advanceTimersByTime(80);
		expect(chunks.join("")).toMatch(/Searching Neon docs/);
		spinner.stop();
		expect(chunks.at(-1)).toBe("\r\x1b[2K");
		const writes = chunks.length;
		spinner.stop();
		expect(chunks).toHaveLength(writes);
	});

	test("writes nothing when the stream is not a TTY", () => {
		const { chunks, out } = capture();
		const spinner = createThinkingSpinner({ out, isTty: false });
		spinner.start();
		spinner.setMessage("Thinking");
		spinner.stop();
		expect(chunks).toEqual([]);
	});
});
