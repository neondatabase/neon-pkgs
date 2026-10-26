import {
	LoadSettingError,
	UnsupportedFunctionalityError,
} from "@ai-sdk/provider";
import {
	experimental_decide as decide,
	type Experimental_DecisionModel,
} from "ai-v7";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	startTestGateway,
	type TestGateway,
} from "../../test/gateway-server.js";
import { createNeon } from "./provider.js";

const DECISION_OK = {
	model: "typesafeai-jev-1-14-0",
	answers: {
		billing: { type: "noul", noul: 0.97 },
		team: {
			type: "choice",
			choice: "payments",
			probabilities: { payments: 0.87, frontend: 0.13 },
			confidence: 0.8,
		},
		urgency: {
			type: "score",
			score: 2,
			probabilities: { "0": 0, "1": 0, "2": 1 },
			confidence: 0.72,
		},
	},
	usage: { input_tokens: 275, output_tokens: 20 },
};

const BILLING_OK = {
	model: "typesafeai-jev-1-14-0",
	answers: { billing: { type: "noul", noul: 0.97 } },
	usage: { input_tokens: 275, output_tokens: 20 },
};

const BILLING = {
	billing: {
		type: "boolean",
		instructions: "Is the user asking about billing?",
		criteria: { true: "Billing related", false: "Not billing" },
	},
} as const;

describe("neon.decisionModel", () => {
	let gateway: TestGateway | undefined;

	afterEach(async () => {
		await gateway?.close();
		gateway = undefined;
	});

	it("satisfies the AI SDK 7 decision model contract", () => {
		const model: Experimental_DecisionModel = createNeon().decisionModel(
			"typesafeai-jev-1-14-0",
		);
		expect(model).toMatchObject({
			specificationVersion: "v4",
			provider: "neon.decision",
			modelId: "typesafeai-jev-1-14-0",
			supportedQuestionTypes: ["choice", "score", "boolean"],
		});
	});

	it("does not resolve configuration until a request is made", () => {
		vi.stubEnv("NEON_AI_GATEWAY_BASE_URL", undefined);
		vi.stubEnv("NEON_AI_GATEWAY_TOKEN", undefined);
		expect(() =>
			createNeon().decisionModel("typesafeai-jev-1-14-0"),
		).not.toThrow();
	});

	it("posts TypeSafe's System One request to the gateway and maps every answer type", async () => {
		gateway = await startTestGateway({ body: DECISION_OK });
		const neon = createNeon({
			baseURL: gateway.baseURL,
			apiKey: "test-token",
		});

		const result = await decide({
			model: neon.decisionModel("typesafeai-jev-1-14-0"),
			state: "I was charged twice this month.",
			questions: {
				...BILLING,
				team: {
					type: "choice",
					instructions: "Which team should own this?",
					criteria: { payments: "Payments", frontend: "Frontend" },
				},
				urgency: {
					type: "score",
					instructions: "How urgent is this?",
					criteria: ["Later", "This week", "Now"],
				},
			},
		});

		expect(gateway.requests).toHaveLength(1);
		const [request] = gateway.requests;
		expect(request.method).toBe("POST");
		expect(request.path).toBe("/typesafe/v1/systemone");
		expect(request.headers.authorization).toBe("Bearer test-token");
		expect(request.body).toEqual({
			model: "typesafeai-jev-1-14-0",
			state: "I was charged twice this month.",
			questions: {
				billing: {
					type: "noul",
					instructions: "Is the user asking about billing?",
					criteria: { true: "Billing related", false: "Not billing" },
				},
				team: {
					type: "choice",
					instructions: "Which team should own this?",
					criteria: { payments: "Payments", frontend: "Frontend" },
				},
				urgency: {
					type: "score",
					instructions: "How urgent is this?",
					criteria: ["Later", "This week", "Now"],
				},
			},
		});

		expect(result.answers.billing).toEqual({
			type: "boolean",
			probability: 0.97,
		});
		expect(result.answers.team).toEqual({
			type: "choice",
			choice: "payments",
			probabilities: { payments: 0.87, frontend: 0.13 },
		});
		expect(result.answers.urgency).toEqual({
			type: "score",
			score: 2,
			probabilities: { "0": 0, "1": 0, "2": 1 },
		});
		expect(result.usage).toEqual({
			inputTokens: 275,
			outputTokens: 20,
			totalTokens: 295,
		});
		expect(result.providerMetadata).toEqual({
			neon: { confidence: { team: 0.8, urgency: 0.72 } },
		});
		expect(result.response.modelId).toBe("typesafeai-jev-1-14-0");
	});

	it("sends a single JSON state part as the JSON value", async () => {
		gateway = await startTestGateway({
			body: { answers: { billing: { type: "noul", noul: 0.5 } } },
		});
		const neon = createNeon({
			baseURL: gateway.baseURL,
			apiKey: "test-token",
		});

		await decide({
			model: neon.decisionModel("openjev-qwen35-4b"),
			state: { ticket: "Charged twice", tier: "enterprise" },
			questions: BILLING,
		});

		expect(gateway.requests[0].body?.state).toEqual({
			ticket: "Charged twice",
			tier: "enterprise",
		});
	});

	it("rejects file state before sending a request", async () => {
		gateway = await startTestGateway({ body: BILLING_OK });
		const model = createNeon({
			baseURL: gateway.baseURL,
			apiKey: "test-token",
		}).decisionModel("typesafeai-jev-1-14-0");

		await expect(
			model.doDecide({
				state: [
					{
						type: "file",
						mediaType: "image/png",
						data: new Uint8Array([1]),
					},
				],
				questions: BILLING,
			}),
		).rejects.toBeInstanceOf(UnsupportedFunctionalityError);
		expect(gateway.requests).toHaveLength(0);
	});

	it("names the minimum ai version when given raw state from an older release", async () => {
		gateway = await startTestGateway({ body: BILLING_OK });
		const model = createNeon({
			baseURL: gateway.baseURL,
			apiKey: "test-token",
		}).decisionModel("typesafeai-jev-1-14-0");

		await expect(
			model.doDecide({
				// @ts-expect-error ai@7.0.130-7.0.132 pass the raw state value
				state: "I was charged twice this month.",
				questions: BILLING,
			}),
		).rejects.toThrow("upgrade ai to 7.0.133 or newer");
		expect(gateway.requests).toHaveLength(0);
	});

	it("reads the base URL and token from the environment", async () => {
		gateway = await startTestGateway({ body: BILLING_OK });
		vi.stubEnv("NEON_AI_GATEWAY_BASE_URL", gateway.baseURL);
		vi.stubEnv("NEON_AI_GATEWAY_TOKEN", "env-token");

		await decide({
			model: createNeon().decisionModel("typesafeai-jev-1-14-0"),
			state: "I was charged twice this month.",
			questions: BILLING,
		});

		expect(gateway.requests[0].headers.authorization).toBe(
			"Bearer env-token",
		);
	});

	it("names the missing base URL setting", async () => {
		vi.stubEnv("NEON_AI_GATEWAY_BASE_URL", undefined);
		const model = createNeon({ apiKey: "test-token" }).decisionModel(
			"typesafeai-jev-1-14-0",
		);

		const error = await model
			.doDecide({
				state: [{ type: "text", text: "hi" }],
				questions: BILLING,
			})
			.catch((caught: unknown) => caught);
		expect(LoadSettingError.isInstance(error)).toBe(true);
		expect(String(error)).toContain("NEON_AI_GATEWAY_BASE_URL");
	});

	it("forwards custom headers and uses the custom fetch", async () => {
		gateway = await startTestGateway({ body: BILLING_OK });
		const fetched: string[] = [];
		const neon = createNeon({
			baseURL: gateway.baseURL,
			apiKey: "test-token",
			headers: { "x-team": "dx" },
			fetch: (input, init) => {
				fetched.push(String(input));
				return fetch(input, init);
			},
		});

		await decide({
			model: neon.decisionModel("typesafeai-jev-1-14-0"),
			state: "I was charged twice this month.",
			questions: BILLING,
			headers: { "x-call": "1" },
		});

		expect(fetched).toEqual([`${gateway.baseURL}/typesafe/v1/systemone`]);
		expect(gateway.requests[0].headers["x-team"]).toBe("dx");
		expect(gateway.requests[0].headers["x-call"]).toBe("1");
	});

	it.each([
		{
			envelope: "the gateway's own rejection",
			body: {
				error: {
					message:
						"ai gateway not enabled for account. Contact Neon support for help.",
				},
			},
		},
		{
			envelope: "a flat Databricks rejection",
			body: {
				error_code: "BAD_REQUEST",
				message:
					"ai gateway not enabled for account. Contact Neon support for help.",
			},
		},
	])("surfaces the reason from $envelope", async ({ body }) => {
		gateway = await startTestGateway({ status: 403, body });
		const neon = createNeon({
			baseURL: gateway.baseURL,
			apiKey: "test-token",
		});

		await expect(
			decide({
				model: neon.decisionModel("typesafeai-jev-1-14-0"),
				state: "I was charged twice this month.",
				questions: BILLING,
			}),
		).rejects.toThrow(
			"ai gateway not enabled for account. Contact Neon support for help.",
		);
	});
});
