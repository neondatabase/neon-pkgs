import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import {
	CHAT_OK,
	RESPONSES_OK,
	startTestGateway,
} from "../../test/gateway-server.js";
import { normalizeGatewayErrorBody } from "./neon-gateway-error.js";
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
		expect(
			normalizeGatewayErrorBody(DATABRICKS_FLAT, "openai"),
		).toMatchObject({
			error: { message: DATABRICKS_FLAT.message, code: "BAD_REQUEST" },
			// The original is kept so it still reaches `responseBody`.
			error_code: "BAD_REQUEST",
		});
	});

	it("unwraps an upstream error carried as a JSON string", () => {
		expect(
			normalizeGatewayErrorBody(DATABRICKS_WRAPPED, "openai"),
		).toMatchObject({
			error: {
				message:
					"Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 1 instead.",
				type: "invalid_request_error",
				param: "max_output_tokens",
				code: "integer_below_min_value",
			},
		});
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
		expect(
			normalizeGatewayErrorBody(DATABRICKS_FLAT, "anthropic"),
		).toMatchObject({
			type: "error",
			error: {
				type: "BAD_REQUEST",
				message: DATABRICKS_FLAT.message,
			},
		});
	});

	it("unwraps an upstream error carried as a JSON string", () => {
		expect(
			normalizeGatewayErrorBody(DATABRICKS_WRAPPED, "anthropic"),
		).toMatchObject({
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

describe("error surfacing over a real socket", () => {
	async function messageFor(modelId: string, body: unknown, status = 400) {
		const gateway = await startTestGateway({ body, status });
		try {
			const neon = createNeon({
				baseURL: gateway.baseURL,
				apiKey: "test-token",
			});
			await generateText({ model: neon(modelId), prompt: "hi" });
		} catch (error) {
			return (error as { message: string }).message;
		} finally {
			await gateway.close();
		}
		throw new Error("expected the call to reject");
	}

	it.each<[string, string]>([
		["responses", "gpt-5-2"],
		["chat completions", "llama-4-maverick"],
		["anthropic messages", "claude-haiku-4-5"],
	])("surfaces the reason on the %s route", async (_route, modelId) => {
		const message = await messageFor(modelId, DATABRICKS_FLAT);

		expect(message).toContain("service_tier");
		expect(message).not.toBe("Bad Request");
	});

	it("keeps the gateway's own diagnostics on the error", async () => {
		const gateway = await startTestGateway({
			body: DATABRICKS_FLAT,
			status: 400,
		});
		try {
			const neon = createNeon({
				baseURL: gateway.baseURL,
				apiKey: "test-token",
			});
			await generateText({ model: neon("gpt-5-2"), prompt: "hi" });
			throw new Error("expected the call to reject");
		} catch (error) {
			expect((error as { responseBody?: string }).responseBody).toContain(
				"error_code",
			);
		} finally {
			await gateway.close();
		}
	});

	it("drops the headers invalidated by rewriting the body", async () => {
		const gateway = await startTestGateway({
			body: DATABRICKS_FLAT,
			status: 400,
		});
		try {
			const neon = createNeon({
				baseURL: gateway.baseURL,
				apiKey: "test-token",
			});
			await generateText({ model: neon("gpt-5-2"), prompt: "hi" });
			throw new Error("expected the call to reject");
		} catch (error) {
			const headers = (
				error as { responseHeaders?: Record<string, string> }
			).responseHeaders;
			expect(headers).not.toHaveProperty("content-length");
		} finally {
			await gateway.close();
		}
	});

	it("passes a successful response through", async () => {
		const gateway = await startTestGateway({ body: RESPONSES_OK });
		try {
			const neon = createNeon({
				baseURL: gateway.baseURL,
				apiKey: "test-token",
			});
			const result = await generateText({
				model: neon("gpt-5-2"),
				prompt: "hi",
			});
			expect(result.text).toBe("pong");
		} finally {
			await gateway.close();
		}
	});

	it("passes a successful chat response through the harmony wrapper", async () => {
		const gateway = await startTestGateway({ body: CHAT_OK });
		try {
			const neon = createNeon({
				baseURL: gateway.baseURL,
				apiKey: "test-token",
			});
			const result = await generateText({
				model: neon("llama-4-maverick"),
				prompt: "hi",
			});
			expect(result.text).toBe("pong");
		} finally {
			await gateway.close();
		}
	});

	it("leaves a non-JSON error body alone", async () => {
		const gateway = await startTestGateway({
			body: "upstream exploded",
			status: 400,
			contentType: "text/plain",
		});
		let message = "";
		try {
			const neon = createNeon({ baseURL: gateway.baseURL, apiKey: "t" });
			await generateText({ model: neon("gpt-5-2"), prompt: "hi" });
		} catch (error) {
			message = (error as { message: string }).message;
		} finally {
			await gateway.close();
		}

		// Untouched: the body never became an envelope either model could read,
		// so the SDK still falls back to the status line and keeps the raw body.
		expect(message).toBe("Bad Request");
	});
});
