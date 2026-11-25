import { describe, expect, it } from "vitest";
import {
	extractHarmonyContent,
	firstChoiceField,
	imageFilesFrom,
	normalizeChunkBody,
	normalizeCompletionBody,
} from "./neon-harmony-normalize.js";

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

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
				summary: [
					{ type: "summary_text", text: "Think about the greeting." },
				],
			},
			{ type: "text", text: "Hi! 👋" },
		];
		expect(extractHarmonyContent(content)).toEqual({
			text: "Hi! 👋",
			reasoning: "Think about the greeting.",
			images: [],
		});
	});

	it("joins multiple text parts and reasoning sources", () => {
		const content = [
			{
				type: "reasoning",
				text: "raw cot",
				summary: [{ text: "summary cot" }],
			},
			{
				type: "reasoning",
				content: [{ type: "reasoning_text", text: "more cot" }],
			},
			{ type: "text", text: "Hello " },
			{ type: "text", text: "world" },
		];
		expect(extractHarmonyContent(content)).toEqual({
			text: "Hello world",
			reasoning: "raw cot\nsummary cot\nmore cot",
			images: [],
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
							{
								type: "reasoning",
								summary: [
									{ type: "summary_text", text: "why" },
								],
							},
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
		const { body: out, changed } = normalizeCompletionBody(
			structuredClone(body),
		);
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
		const choice = (
			out as { choices: Array<{ message: Record<string, unknown> }> }
		).choices[0];
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
							{
								type: "reasoning",
								summary: [
									{ type: "summary_text", text: "thinking" },
								],
							},
						],
					},
					finish_reason: null,
				},
			],
		};
		const { body: out, changed } = normalizeChunkBody(chunk);
		expect(changed).toBe(true);
		const delta = (
			out as { choices: Array<{ delta: Record<string, unknown> }> }
		).choices[0].delta;
		expect(delta.content).toBeUndefined();
		expect(delta.reasoning_content).toBe("thinking");
	});

	it("rewrites a text delta to a string", () => {
		const chunk = {
			choices: [
				{ delta: { content: [{ type: "text", text: "Hello" }] } },
			],
		};
		const { body: out, changed } = normalizeChunkBody(chunk);
		expect(changed).toBe(true);
		const delta = (
			out as { choices: Array<{ delta: Record<string, unknown> }> }
		).choices[0].delta;
		expect(delta.content).toBe("Hello");
	});

	it("leaves a compliant string delta untouched (changed=false)", () => {
		const chunk = { choices: [{ delta: { content: "Hello" } }] };
		const { body: out, changed } = normalizeChunkBody(
			structuredClone(chunk),
		);
		expect(changed).toBe(false);
		expect(out).toEqual(chunk);
	});
});

describe("generated images", () => {
	it("moves image_url parts of a completion to message.images and keeps reasoning", () => {
		const body = {
			choices: [
				{
					message: {
						role: "assistant",
						content: [
							{
								type: "reasoning",
								summary: [
									{
										type: "summary_text",
										text: "Plan the scene.",
									},
								],
							},
							{
								type: "image_url",
								image_url: { url: PNG_DATA_URL },
							},
						],
					},
				},
			],
		};
		const { body: out, changed } = normalizeCompletionBody(body);
		expect(changed).toBe(true);
		expect(firstChoiceField(out, "message")).toEqual({
			role: "assistant",
			content: "",
			reasoning_content: "Plan the scene.",
			images: [{ type: "image_url", image_url: { url: PNG_DATA_URL } }],
		});
	});

	it("moves image_url parts of a streamed delta to delta.images", () => {
		const chunk = {
			choices: [
				{
					delta: {
						content: [
							{
								type: "image_url",
								image_url: { url: PNG_DATA_URL },
							},
						],
					},
				},
			],
		};
		const { body: out, changed } = normalizeChunkBody(chunk);
		expect(changed).toBe(true);
		expect(firstChoiceField(out, "delta")).toEqual({
			content: undefined,
			images: [{ type: "image_url", image_url: { url: PNG_DATA_URL } }],
		});
	});

	it("turns images into AI SDK file parts with the data URL's media type", () => {
		expect(
			imageFilesFrom({
				images: [
					{ type: "image_url", image_url: { url: PNG_DATA_URL } },
					{
						type: "image_url",
						image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" },
					},
				],
			}),
		).toEqual([
			{ type: "file", mediaType: "image/png", data: "iVBORw0KGgo=" },
			{ type: "file", mediaType: "image/jpeg", data: "/9j/4AAQ" },
		]);
	});

	it("returns no files for a message without images", () => {
		expect(imageFilesFrom({ role: "assistant", content: "Hi" })).toEqual(
			[],
		);
		expect(imageFilesFrom(undefined)).toEqual([]);
	});

	it("throws on an image that is not a base64 data URL", () => {
		expect(() =>
			imageFilesFrom({
				images: [
					{
						type: "image_url",
						image_url: { url: "https://example.com/a.png" },
					},
				],
			}),
		).toThrow(/only reads base64 data URLs/);
	});
});
