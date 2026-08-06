import { describe, expect, it } from "vitest";
import {
	getNeonModelCapabilities,
	getNeonModelRoute,
} from "./neon-model-capabilities.js";

describe("getNeonModelRoute", () => {
	it("routes Anthropic and OpenAI models to their native endpoints", () => {
		expect(getNeonModelRoute("claude-opus-4-8")).toBe("anthropic");
		expect(getNeonModelRoute("claude-haiku-4-5")).toBe("anthropic");
		expect(getNeonModelRoute("gpt-5")).toBe("openai");
		expect(getNeonModelRoute("gpt-5-mini")).toBe("openai");
		expect(getNeonModelRoute("gpt-5-3-codex")).toBe("openai");
	});

	it("falls back to the unified MLflow endpoint for everything else", () => {
		// Gemini is routed to MLflow because its native endpoint cannot stream.
		expect(getNeonModelRoute("gemini-3-flash")).toBe("mlflow");
		expect(getNeonModelRoute("llama-4-maverick")).toBe("mlflow");
		expect(getNeonModelRoute("qwen35-122b-a10b")).toBe("mlflow");
		// gpt-oss is open-weight and served on the unified endpoint, not Responses.
		expect(getNeonModelRoute("gpt-oss-120b")).toBe("mlflow");
	});

	it("routes the legacy databricks- prefixed ids identically", () => {
		// The gateway accepts both id forms; routing matches on the id substring,
		// so the prefixed and canonical forms must resolve to the same endpoint.
		const pairs: Array<[string, string]> = [
			["claude-haiku-4-5", "databricks-claude-haiku-4-5"],
			["gpt-5", "databricks-gpt-5"],
			["gpt-5-3-codex", "databricks-gpt-5-3-codex"],
			["gemini-3-flash", "databricks-gemini-3-flash"],
			["gpt-oss-120b", "databricks-gpt-oss-120b"],
		];
		for (const [canonical, prefixed] of pairs) {
			expect(getNeonModelRoute(prefixed)).toBe(
				getNeonModelRoute(canonical),
			);
		}
	});
});

describe("getNeonModelCapabilities", () => {
	it("marks Anthropic models correctly", () => {
		const caps = getNeonModelCapabilities("claude-haiku-4-5");
		expect(caps.family).toBe("anthropic");
		expect(caps.supportsPenalties).toBe(false);
		expect(caps.supportsSeed).toBe(false);
		expect(caps.temperatureTopPMutuallyExclusive).toBe(true);
		expect(caps.supportsReasoningEffort).toBe(false);
	});

	it("marks plain GPT-5 reasoning models without temperature/topP support", () => {
		const caps = getNeonModelCapabilities("gpt-5-mini");
		expect(caps.family).toBe("openai");
		expect(caps.supportsTemperature).toBe(false);
		expect(caps.supportsTopP).toBe(false);
	});

	it("keeps temperature for gpt-5.1+ models", () => {
		const caps = getNeonModelCapabilities("gpt-5-1");
		expect(caps.supportsTemperature).toBe(true);
		expect(caps.supportsTopP).toBe(true);
	});

	it("marks Meta models without penalties/seed support", () => {
		const caps = getNeonModelCapabilities("llama-4-maverick");
		expect(caps.family).toBe("meta");
		expect(caps.supportsPenalties).toBe(false);
		expect(caps.supportsSeed).toBe(false);
	});

	// Measured against a live gateway branch: 4.1/4.5/4.6 accept temperature and
	// top_p, 4.7 onward reject both with "does not support the temperature
	// parameter".
	it("keeps sampling params for Claude 4.6 and earlier", () => {
		for (const id of [
			"claude-haiku-4-5",
			"claude-opus-4-1",
			"claude-opus-4-6",
			"claude-sonnet-4-6",
		]) {
			const caps = getNeonModelCapabilities(id);
			expect({
				id,
				temperature: caps.supportsTemperature,
				topP: caps.supportsTopP,
			}).toEqual({ id, temperature: true, topP: true });
		}
	});

	it("drops sampling params from Claude 4.7 onward", () => {
		for (const id of [
			"claude-opus-4-7",
			"claude-opus-4-8",
			"claude-opus-5",
			"claude-sonnet-5",
			"claude-fable-5",
		]) {
			const caps = getNeonModelCapabilities(id);
			expect({
				id,
				temperature: caps.supportsTemperature,
				topP: caps.supportsTopP,
			}).toEqual({ id, temperature: false, topP: false });
		}
	});

	it("treats an unparseable Claude id as new rather than permissive", () => {
		// Dropping a supported parameter costs a warning; claiming an unsupported
		// one costs a 400, so the unknown case must fall on the strict side.
		const caps = getNeonModelCapabilities("claude-something-unreleased");
		expect(caps.supportsTemperature).toBe(false);
	});

	// Every MLflow-routed family except Gemini rejects penalties with
	// `parameter "frequency_penalty" must be equal to 0`.
	it("drops penalties for every unified-endpoint family that rejects them", () => {
		for (const id of [
			"gpt-oss-20b",
			"gpt-oss-120b",
			"qwen35-122b-a10b",
			"qwen3-next-80b-a3b-instruct",
			"gemma-3-12b",
			"glm-5-2",
			"inkling",
		]) {
			expect({
				id,
				penalties: getNeonModelCapabilities(id).supportsPenalties,
			}).toEqual({
				id,
				penalties: false,
			});
		}
	});

	it("keeps penalties for Gemini, the one unified family that accepts them", () => {
		expect(
			getNeonModelCapabilities("gemini-3-flash").supportsPenalties,
		).toBe(true);
	});

	it("separates seed and stop support across the unified families", () => {
		// gpt-oss rejects both; qwen and gemma reject seed only; glm and inkling
		// accept both.
		expect(getNeonModelCapabilities("gpt-oss-20b").supportsSeed).toBe(
			false,
		);
		expect(
			getNeonModelCapabilities("gpt-oss-20b").supportsStopSequences,
		).toBe(false);
		expect(getNeonModelCapabilities("qwen35-122b-a10b").supportsSeed).toBe(
			false,
		);
		expect(
			getNeonModelCapabilities("qwen35-122b-a10b").supportsStopSequences,
		).toBe(true);
		expect(getNeonModelCapabilities("glm-5-2").supportsSeed).toBe(true);
		expect(getNeonModelCapabilities("inkling").supportsStopSequences).toBe(
			true,
		);
	});

	it("is permissive for a genuinely unknown model", () => {
		const caps = getNeonModelCapabilities("some-future-model-v1");
		expect(caps.family).toBe("other");
		expect(caps.supportsPenalties).toBe(true);
		expect(caps.supportsReasoningEffort).toBe(true);
	});

	it("detects capabilities identically for legacy databricks- prefixed ids", () => {
		const ids = [
			"claude-haiku-4-5",
			"gpt-5-mini",
			"gpt-5-1",
			"gemini-3-flash",
			"llama-4-maverick",
			"qwen35-122b-a10b",
		];
		for (const id of ids) {
			expect(getNeonModelCapabilities(`databricks-${id}`)).toEqual(
				getNeonModelCapabilities(id),
			);
		}
	});
});
