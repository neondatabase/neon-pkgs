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

	it("is permissive for unknown models", () => {
		const caps = getNeonModelCapabilities("qwen35-122b-a10b");
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
