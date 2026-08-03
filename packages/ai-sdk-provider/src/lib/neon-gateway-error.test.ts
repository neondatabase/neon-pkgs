import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import {
	normalizeGatewayErrorBody,
	wrapFetchWithGatewayErrorNormalization,
} from "./neon-gateway-error.js";
import { createNeon } from "./provider.js";

// Captured verbatim from a live branch gateway on /openai/v1/responses.
const OPENAI_SHAPED = {
	error: { message: 'unknown model "nope-not-a-model"' },
};
const DATABRICKS_FLAT = {
	error_code: "INVALID_PARAMETER_VALUE",
	message:
		"INVALID_PARAMETER_VALUE: Databricks does not support store response for OpenAI Responses API. Please contact your Databricks account team to enable this feature",
};
const DATABRICKS_WRAPPED = {
	error_code: "BAD_REQUEST",
	message: JSON.stringify({
		error: {
			message:
				"Invalid 'temperature': decimal above maximum value. Expected a value <= 2.0, but got 9.5 instead.",
			type: "invalid_request_error",
			param: "temperature",
			code: "decimal_above_max_value",
		},
	}),
};

describe("normalizeGatewayErrorBody", () => {
	it("leaves an already OpenAI-shaped envelope alone", () => {
		expect(normalizeGatewayErrorBody(OPENAI_SHAPED)).toBeNull();
	});

	it("lifts a flat Databricks rejection into error.message", () => {
		expect(normalizeGatewayErrorBody(DATABRICKS_FLAT)).toEqual({
			error: {
				message: DATABRICKS_FLAT.message,
				code: "INVALID_PARAMETER_VALUE",
			},
		});
	});

	it("unwraps an OpenAI error carried as a JSON string", () => {
		expect(normalizeGatewayErrorBody(DATABRICKS_WRAPPED)).toEqual({
			error: {
				message:
					"Invalid 'temperature': decimal above maximum value. Expected a value <= 2.0, but got 9.5 instead.",
				type: "invalid_request_error",
				param: "temperature",
				code: "decimal_above_max_value",
			},
		});
	});

	it("ignores shapes it does not recognise", () => {
		expect(normalizeGatewayErrorBody({ detail: "nope" })).toBeNull();
		expect(normalizeGatewayErrorBody("plain text")).toBeNull();
	});
});

describe("wrapFetchWithGatewayErrorNormalization", () => {
	const jsonResponse = (body: unknown, status: number) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});

	it("passes successful responses through untouched", async () => {
		const wrapped = wrapFetchWithGatewayErrorNormalization(async () =>
			jsonResponse({ ok: true }, 200),
		);
		const res = await wrapped("https://example.com");

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ ok: true });
	});

	it("rewrites a Databricks error body", async () => {
		const wrapped = wrapFetchWithGatewayErrorNormalization(async () =>
			jsonResponse(DATABRICKS_FLAT, 400),
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
		);
		const res = await wrapped("https://example.com");

		await expect(res.text()).resolves.toBe("upstream exploded");
	});
});

describe("error surfacing through the provider", () => {
	async function messageFor(body: unknown) {
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
			await generateText({ model: neon("gpt-5-2"), prompt: "hi" });
		} catch (error) {
			return (error as { message: string }).message;
		}
		throw new Error("expected the call to reject");
	}

	it("surfaces the Databricks reason instead of a bare status line", async () => {
		const message = await messageFor(DATABRICKS_FLAT);

		expect(message).toContain("Databricks does not support store response");
		expect(message).not.toBe("Bad Request");
	});

	it("surfaces the offending parameter from a wrapped OpenAI error", async () => {
		const message = await messageFor(DATABRICKS_WRAPPED);

		expect(message).toContain("Invalid 'temperature'");
	});
});
