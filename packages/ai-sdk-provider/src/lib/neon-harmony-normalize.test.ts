import { describe, expect, it } from "vitest";
import {
	extractHarmonyContent,
	normalizeChunkBody,
	normalizeCompletionBody,
} from "./neon-harmony-normalize.js";

describe("extractHarmonyContent", () => {
	it("returns null for a compliant string content (no rewrite needed)", () => {
		expect(extractHarmonyContent("Hi there")).toBeNull();
		expect(extractHarmonyContent(null)).toBeNull();
		expect(extractHarmonyContent(undefined)).toBeNull();
	});

	it("flattens text parts and hoists reasoning from summary_text", () => {
		const content = [
			{
				type: "reasoning",
				summary: [{ type: "summary_text", text: "Think about the greeting." }],
			},
			{ type: "text", text: "Hi! 👋" },
		];
		expect(extractHarmonyContent(content)).toEqual({
			text: "Hi! 👋",
			reasoning: "Think about the greeting.",
		});
	});

	it("joins multiple text parts and reasoning sources", () => {
		const content = [
			{ type: "reasoning", text: "raw cot", summary: [{ text: "summary cot" }] },
			{ type: "reasoning", content: [{ type: "reasoning_text", text: "more cot" }] },
			{ type: "text", text: "Hello " },
			{ type: "text", text: "world" },
		];
		expect(extractHarmonyContent(content)).toEqual({
			text: "Hello world",
			reasoning: "raw cot\nsummary cot\nmore cot",
		});
	});
});

describe("normalizeCompletionBody", () => {
	it("rewrites gpt-oss array content to string + reasoning_content", () => {
		const body = {
			object: "chat.completion",
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: [
							{ type: "reasoning", summary: [{ type: "summary_text", text: "why" }] },
							{ type: "text", text: "Hi" },
						],
					},
					finish_reason: "stop",
				},
			],
		};
		const { body: out, changed } = normalizeCompletionBody(body);
		expect(changed).toBe(true);
		expect(out).toEqual({
			object: "chat.completion",
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: "Hi",
						reasoning_content: "why",
					},
					finish_reason: "stop",
				},
			],
		});
	});

	it("leaves a compliant string-content body untouched (changed=false)", () => {
		const body = {
			choices: [{ message: { role: "assistant", content: "Hi there" } }],
		};
		const { body: out, changed } = normalizeCompletionBody(structuredClone(body));
		expect(changed).toBe(false);
		expect(out).toEqual(body);
	});

	it("does not overwrite an existing reasoning field", () => {
		const body = {
			choices: [
				{
					message: {
						role: "assistant",
						reasoning: "already here",
						content: [{ type: "text", text: "Hi" }],
					},
				},
			],
		};
		const { body: out, changed } = normalizeCompletionBody(body);
		expect(changed).toBe(true);
		const choice = (out as { choices: Array<{ message: Record<string, unknown> }> })
			.choices[0];
		expect(choice.message.content).toBe("Hi");
		expect(choice.message.reasoning).toBe("already here");
		expect(choice.message.reasoning_content).toBeUndefined();
	});
});

describe("normalizeChunkBody", () => {
	it("rewrites a reasoning-only delta to reasoning_content and drops empty text", () => {
		const chunk = {
			object: "chat.completion.chunk",
			choices: [
				{
					index: 0,
					delta: {
						content: [
							{ type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] },
						],
					},
					finish_reason: null,
				},
			],
		};
		const { body: out, changed } = normalizeChunkBody(chunk);
		expect(changed).toBe(true);
		const delta = (out as { choices: Array<{ delta: Record<string, unknown> }> })
			.choices[0].delta;
		expect(delta.content).toBeUndefined();
		expect(delta.reasoning_content).toBe("thinking");
	});

	it("rewrites a text delta to a string", () => {
		const chunk = {
			choices: [{ delta: { content: [{ type: "text", text: "Hello" }] } }],
		};
		const { body: out, changed } = normalizeChunkBody(chunk);
		expect(changed).toBe(true);
		const delta = (out as { choices: Array<{ delta: Record<string, unknown> }> })
			.choices[0].delta;
		expect(delta.content).toBe("Hello");
	});

	it("leaves a compliant string delta untouched (changed=false)", () => {
		const chunk = { choices: [{ delta: { content: "Hello" } }] };
		const { body: out, changed } = normalizeChunkBody(structuredClone(chunk));
		expect(changed).toBe(false);
		expect(out).toEqual(chunk);
	});
});
