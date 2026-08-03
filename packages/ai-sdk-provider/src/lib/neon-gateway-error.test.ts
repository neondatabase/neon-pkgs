import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import {
	type GatewayErrorDialect,
	normalizeGatewayErrorBody,
	wrapFetchWithGatewayErrorNormalization,
} from "./neon-gateway-error.js";
import { createNeon } from "./provider.js";

// Captured verbatim from a live branch gateway.
const OPENAI_SHAPED = {
	error: { message: 'unknown model "nope-not-a-model"' },
};
const DATABRICKS_FLAT = {
	error_code: "BAD_REQUEST",
	message: "BAD_REQUEST: service_tier='flex' is not supported by Databricks",
};
const DATABRICKS_WRAPPED = {
	error_code: "BAD_REQUEST",
	message: JSON.stringify({
		error: {
			message:
				"Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 1 instead.",
			type: "invalid_request_error",
			param: "max_output_tokens",
			code: "integer_below_min_value",
		},
	}),
};
const ANTHROPIC_SHAPED = {
	type: "error",
	error: { type: "invalid_request_error", message: "max_tokens is required" },
};

describe("normalizeGatewayErrorBody — openai dialect", () => {
	it("leaves an already OpenAI-shaped envelope alone", () => {
		expect(normalizeGatewayErrorBody(OPENAI_SHAPED, "openai")).toBeNull();
	});

	it("lifts a flat Databricks rejection into error.message", () => {
		expect(normalizeGatewayErrorBody(DATABRICKS_FLAT, "openai")).toEqual({
			error: { message: DATABRICKS_FLAT.message, code: "BAD_REQUEST" },
		});
	});

	it("unwraps an upstream error carried as a JSON string", () => {
		expect(normalizeGatewayErrorBody(DATABRICKS_WRAPPED, "openai")).toEqual(
			{
				error: {
					message:
						"Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 1 instead.",
					type: "invalid_request_error",
					param: "max_output_tokens",
					code: "integer_below_min_value",
				},
			},
		);
	});

	it("leaves an Anthropic envelope alone, because it already parses here", () => {
		// The OpenAI schema only requires a nested `error.message` string and
		// ignores the extra top-level `type`, so an Anthropic body is readable
		// as-is. The reverse is not true — see the anthropic dialect below.
		expect(
			normalizeGatewayErrorBody(ANTHROPIC_SHAPED, "openai"),
		).toBeNull();
	});
});

describe("normalizeGatewayErrorBody — anthropic dialect", () => {
	it("leaves an already Anthropic-shaped envelope alone", () => {
		expect(
			normalizeGatewayErrorBody(ANTHROPIC_SHAPED, "anthropic"),
		).toBeNull();
	});

	it("converts the gateway's OpenAI-shaped rejection", () => {
		// The gateway emits this shape on every route, including /anthropic/v1,
		// where it would otherwise be dropped for lacking `type: "error"`.
		expect(normalizeGatewayErrorBody(OPENAI_SHAPED, "anthropic")).toEqual({
			type: "error",
			error: {
				type: "api_error",
				message: 'unknown model "nope-not-a-model"',
			},
		});
	});

	it("converts a flat Databricks rejection, keeping the code as the type", () => {
		expect(normalizeGatewayErrorBody(DATABRICKS_FLAT, "anthropic")).toEqual(
			{
				type: "error",
				error: {
					type: "BAD_REQUEST",
					message: DATABRICKS_FLAT.message,
				},
			},
		);
	});

	it("unwraps an upstream error carried as a JSON string", () => {
		expect(
			normalizeGatewayErrorBody(DATABRICKS_WRAPPED, "anthropic"),
		).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message:
					"Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 1 instead.",
			},
		});
	});
});

describe("normalizeGatewayErrorBody — unrecognised input", () => {
	it.each<[string, unknown]>([
		["a body with no message", { detail: "nope" }],
		["a bare string", "plain text"],
		["null", null],
		["an array", [1, 2, 3]],
	])("ignores %s", (_label, body) => {
		expect(normalizeGatewayErrorBody(body, "openai")).toBeNull();
		expect(normalizeGatewayErrorBody(body, "anthropic")).toBeNull();
	});
});

describe("wrapFetchWithGatewayErrorNormalization", () => {
	const jsonResponse = (body: unknown, status: number) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});

	it.each<GatewayErrorDialect>([
		"openai",
		"anthropic",
	])("passes successful responses through untouched (%s)", async (dialect) => {
		const wrapped = wrapFetchWithGatewayErrorNormalization(
			async () => jsonResponse({ ok: true }, 200),
			dialect,
		);
		const res = await wrapped("https://example.com");

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ ok: true });
	});

	it("rewrites a failed response and keeps its status", async () => {
		const wrapped = wrapFetchWithGatewayErrorNormalization(
			async () => jsonResponse(DATABRICKS_FLAT, 400),
			"openai",
		);
		const res = await wrapped("https://example.com");

		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({
			error: { message: DATABRICKS_FLAT.message },
		});
	});

	it("leaves a non-JSON error body alone", async () => {
		const wrapped = wrapFetchWithGatewayErrorNormalization(
			async () =>
				new Response("upstream exploded", {
					status: 502,
					headers: { "content-type": "text/plain" },
				}),
			"openai",
		);
		const res = await wrapped("https://example.com");

		await expect(res.text()).resolves.toBe("upstream exploded");
	});
});

describe("error surfacing through the provider", () => {
	async function messageFor(modelId: string, body: unknown) {
		const neon = createNeon({
			baseURL: "https://example.com",
			apiKey: "test-token",
			fetch: async () =>
				new Response(JSON.stringify(body), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		});
		try {
			await generateText({ model: neon(modelId), prompt: "hi" });
		} catch (error) {
			return (error as { message: string }).message;
		}
		throw new Error("expected the call to reject");
	}

	// One case per route, so the wiring in provider.ts is covered end to end.
	it.each<[string, string]>([
		["responses", "gpt-5-2"],
		["chat completions", "llama-4-maverick"],
		["anthropic messages", "claude-haiku-4-5"],
	])("surfaces the reason on the %s route", async (_route, modelId) => {
		const message = await messageFor(modelId, DATABRICKS_FLAT);

		expect(message).toContain("service_tier");
		expect(message).not.toBe("Bad Request");
	});
});
