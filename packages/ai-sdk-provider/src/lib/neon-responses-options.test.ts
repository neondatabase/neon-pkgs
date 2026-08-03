import type { JSONObject, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { withResponsesGatewayDefaults } from "./neon-responses-options.js";

function callOptions(openai?: JSONObject): LanguageModelV3CallOptions {
	return {
		prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		...(openai ? { providerOptions: { openai } } : {}),
	};
}

function openaiOptions(modelId: string, openai?: JSONObject): JSONObject {
	const result = withResponsesGatewayDefaults(modelId, callOptions(openai));
	return result.providerOptions?.openai ?? {};
}

describe("store", () => {
	it("defaults to false when the caller says nothing", () => {
		expect(openaiOptions("gpt-5-2")).toMatchObject({ store: false });
	});

	it("defaults to false on a model that is not a reasoning model", () => {
		expect(openaiOptions("gpt-4-1")).toEqual({ store: false });
	});

	it("treats undefined as unset", () => {
		// `{ store: undefined }` serializes identically to `{}`, so it has to
		// behave identically — otherwise spreading an optional config value
		// silently reinstates the item_reference 502.
		expect(openaiOptions("gpt-5-2", { store: undefined })).toMatchObject({
			store: false,
		});
	});

	it("accepts an explicit false", () => {
		expect(openaiOptions("gpt-5-2", { store: false })).toMatchObject({
			store: false,
		});
	});

	it.each([
		["true", true],
		["null", null],
		["a string", "yes"],
		["an object", { secret: "nt_live_do_not_log_me" }],
	])("refuses %s", (_label, store) => {
		expect(() => openaiOptions("gpt-5-2", { store })).toThrow(
			/must be `false` or omitted/,
		);
	});

	it("names the gateway's own rejection so the caller can act on it", () => {
		expect(() => openaiOptions("gpt-5-2", { store: true })).toThrow(
			/Databricks does not support store response/,
		);
	});

	it("never echoes the received value, which may hold a secret", () => {
		expect(() =>
			openaiOptions("gpt-5-2", {
				store: { secret: "nt_live_do_not_log_me" },
			}),
		).toThrow(/received an object/);
		expect(() =>
			openaiOptions("gpt-5-2", {
				store: { secret: "nt_live_do_not_log_me" },
			}),
		).not.toThrow(/nt_live_do_not_log_me/);
	});
});

describe("forceReasoning", () => {
	it("is set for a bare reasoning id", () => {
		expect(openaiOptions("gpt-5-2")).toMatchObject({
			forceReasoning: true,
		});
	});

	it("is set for the legacy databricks- form, which upstream does not match", () => {
		// The shared model detects reasoning models with a bare `gpt-5` prefix,
		// so the prefixed id would otherwise lose native reasoning.
		expect(openaiOptions("databricks-gpt-5-2")).toMatchObject({
			forceReasoning: true,
		});
	});

	it("treats undefined as unset", () => {
		expect(
			openaiOptions("databricks-gpt-5-2", { forceReasoning: undefined }),
		).toMatchObject({ forceReasoning: true });
	});

	it("respects an explicit false", () => {
		expect(
			openaiOptions("databricks-gpt-5-2", { forceReasoning: false }),
		).toMatchObject({ forceReasoning: false });
	});

	it("is left off a model that is not a reasoning model", () => {
		expect(openaiOptions("gpt-4-1")).not.toHaveProperty("forceReasoning");
	});
});

describe("unrelated options", () => {
	it("keeps other openai options alongside the defaults", () => {
		expect(
			openaiOptions("gpt-5-2", { reasoningEffort: "low" }),
		).toMatchObject({
			reasoningEffort: "low",
			store: false,
			forceReasoning: true,
		});
	});

	it("leaves other provider namespaces untouched", () => {
		const result = withResponsesGatewayDefaults("gpt-5-2", {
			prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			providerOptions: { neon: { reasoningEffort: "low" } },
		});

		expect(result.providerOptions?.neon).toEqual({
			reasoningEffort: "low",
		});
	});
});
