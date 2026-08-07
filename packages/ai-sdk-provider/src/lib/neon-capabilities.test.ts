import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { applyNeonCapabilities } from "./neon-capabilities.js";

/**
 * The sentence a user reads in their terminal is the artifact here, so it is
 * asserted rather than left to drift. Two rounds of review went into this
 * wording: it must not name the family (which is the literal string "other" for
 * half the unified catalog), must not restate what the AI SDK already prints
 * ahead of it, and must not assert a 400 for a model nobody measured.
 */
const call = (
	overrides: Partial<LanguageModelV3CallOptions>,
): LanguageModelV3CallOptions =>
	({
		prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		...overrides,
	}) as LanguageModelV3CallOptions;

const detailsFor = (
	modelId: string,
	overrides: Partial<LanguageModelV3CallOptions>,
) =>
	applyNeonCapabilities(modelId, call(overrides)).warnings.map((w) => ({
		type: w.type,
		feature: "feature" in w ? w.feature : undefined,
		details: "details" in w ? w.details : undefined,
	}));

describe("applyNeonCapabilities warnings", () => {
	it("names the Anthropic effort option, not the OpenAI spelling it drops", () => {
		const [warning] = detailsFor("claude-opus-5", { temperature: 0.2 });

		expect(warning.details).toContain("providerOptions.anthropic.effort");
		// `reasoningEffort` is dropped on every Claude id, so pointing there would
		// send the reader at the one adjacent name that does not work.
		expect(warning.details).not.toMatch(/\breasoningEffort\b/);
	});

	it("never interpolates the capability family into the sentence", () => {
		for (const id of [
			"gpt-oss-120b",
			"glm-5-2",
			"inkling",
			"qwen35-122b-a10b",
		]) {
			const [warning] = detailsFor(id, { frequencyPenalty: 0.5 });
			expect({ id, details: warning.details }).toEqual({
				id,
				details: expect.not.stringContaining("other"),
			});
		}
	});

	it("does not tell a Gemini caller that only Gemini accepts penalties", () => {
		// gemini-3-6-flash and gemini-3-5-flash-lite reject penalties while their
		// older siblings accept them, so a rule phrased around the family reads as
		// a contradiction to exactly the users who now hit it.
		for (const id of ["gemini-3-6-flash", "gemini-3-5-flash-lite"]) {
			const [warning] = detailsFor(id, { frequencyPenalty: 0.5 });
			expect({ id, details: warning.details }).toEqual({
				id,
				details: expect.not.stringContaining("Only Gemini"),
			});
			// The sentence has to add something the SDK's own prefix did not; it
			// already prints provider, model, feature and "is not supported".
			expect(warning.details).toContain("getNeonModelCapabilities");
		}
	});

	// Claude routes through /anthropic/v1, not the unified chat endpoint, so a
	// penalty warning phrased around "the unified endpoint" would be false for
	// every Claude model that receives it.
	it("keeps the penalty warning true on routes other than unified chat", () => {
		for (const id of ["claude-opus-5", "kimi-k3", "gemini-3-6-flash"]) {
			const warning = detailsFor(id, { frequencyPenalty: 0.5 }).find(
				(w) => w.feature === "frequencyPenalty",
			);
			expect({ id, details: warning?.details }).toEqual({
				id,
				details: expect.not.stringContaining("unified endpoint"),
			});
		}
	});

	// temperature and topP read `samplingDetails`, not GENERIC_DETAILS, so the
	// penalty assertions above did not cover them and the old wording survived
	// one round of review on exactly the parameter the finding was about.
	it("gives temperature and topP the same actionable wording as everything else", () => {
		const warnings = detailsFor("gemini-3-6-flash", {
			temperature: 0.2,
			topP: 0.9,
		});

		expect(warnings.map((w) => w.feature)).toEqual(["temperature", "topP"]);
		for (const warning of warnings) {
			expect(warning.details).toContain(
				"The request was sent without it",
			);
			expect(warning.details).toContain("getNeonModelCapabilities");
		}
	});

	it("hedges rather than asserting a 400 for an unrecognised Claude id", () => {
		const [warning] = detailsFor("claude-3-5-sonnet-20241022", {
			temperature: 0.2,
		});

		expect(warning.details).toContain("not recognised");
		expect(warning.details).toContain("as a precaution");
		// `unsupported` renders as a flat "is not supported", contradicting the hedge.
		expect(warning.type).toBe("compatibility");
	});

	it("states the measured rule for a Claude id it does recognise", () => {
		const [warning] = detailsFor("claude-opus-5", { temperature: 0.2 });

		expect(warning.type).toBe("unsupported");
		expect(warning.details).toContain("Claude 4.7 and newer");
		expect(warning.details).toContain("The request was sent without it");
	});

	it("keeps temperature and drops topP when a Claude call sets both", () => {
		const { options } = applyNeonCapabilities(
			"claude-opus-4-6",
			call({ temperature: 0.2, topP: 0.9 }),
		);

		expect(options.temperature).toBe(0.2);
		expect(options.topP).toBeUndefined();
		expect(
			detailsFor("claude-opus-4-6", { temperature: 0.2, topP: 0.9 })[0],
		).toEqual({
			type: "compatibility",
			feature: "topP",
			details: expect.stringContaining(
				"topP was dropped and temperature kept",
			),
		});
	});
});
