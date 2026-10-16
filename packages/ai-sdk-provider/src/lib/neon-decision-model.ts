import {
	type APICallError,
	type SharedV3Headers,
	type SharedV3ProviderMetadata,
	type SharedV3Warning,
	UnsupportedFunctionalityError,
} from "@ai-sdk/provider";
import {
	combineHeaders,
	createJsonResponseHandler,
	type FetchFunction,
	postJsonToApi,
	type ResponseHandler,
} from "@ai-sdk/provider-utils";
import { z } from "zod/v4";

/**
 * A System One decision model id, such as `typesafeai-jev-1-14-0`. Any string is
 * accepted: `GET /v1/models` lists the ids a branch serves, with
 * `dialects: ["systemone"]`.
 */
export type NeonDecisionModelId = string;

// The AI SDK 7 decision contract (`Experimental_DecisionModelV4` in
// `@ai-sdk/provider@4`), written out structurally: every v4 package requires
// Node 22, while this package supports AI SDK 6 on Node 20. Inputs are only
// forwarded, so they are typed as wide as v4's readonly JSON values.
type NeonDecisionInput =
	| string
	| Readonly<Record<string, unknown>>
	| readonly unknown[];

export type NeonDecisionQuestion =
	| {
			readonly type: "choice";
			readonly instructions: NeonDecisionInput;
			readonly criteria: Readonly<
				Record<string, NeonDecisionInput | null>
			>;
	  }
	| {
			readonly type: "score";
			readonly instructions: NeonDecisionInput;
			readonly criteria: readonly (NeonDecisionInput | null)[];
	  }
	| {
			readonly type: "boolean";
			readonly instructions: NeonDecisionInput;
			readonly criteria?: {
				readonly true?: NeonDecisionInput | null;
				readonly false?: NeonDecisionInput | null;
			};
	  };

type NeonDecisionStatePart =
	| { type: "text"; text: string }
	| { type: "file"; mediaType: string; data: unknown }
	| { type: "json"; value: unknown };

export interface NeonDecisionCallOptions {
	state: readonly NeonDecisionStatePart[];
	questions: Readonly<Record<string, NeonDecisionQuestion>>;
	abortSignal?: AbortSignal;
	headers?: SharedV3Headers;
}

export type NeonDecisionAnswer =
	| { type: "choice"; choice: string; probabilities?: Record<string, number> }
	| { type: "score"; score: number; probabilities?: Record<string, number> }
	| { type: "boolean"; probability: number }
	| { type: "refusal" };

export interface NeonDecisionResult {
	answers: Record<string, NeonDecisionAnswer>;
	rounding?: { probabilityDecimals?: number; scoreDecimals?: number };
	usage?: { inputTokens?: number; outputTokens?: number };
	warnings: SharedV3Warning[];
	providerMetadata?: SharedV3ProviderMetadata;
	response?: { modelId?: string; headers?: SharedV3Headers; body?: unknown };
}

export interface NeonDecisionModelConfig {
	provider: string;
	url: () => string;
	headers: () => Record<string, string | undefined>;
	fetch?: FetchFunction;
	failedResponseHandler: ResponseHandler<APICallError>;
}

const systemOneResponseSchema = z.object({
	model: z.string().nullish(),
	answers: z.record(
		z.string(),
		z.discriminatedUnion("type", [
			z.object({
				type: z.literal("choice"),
				choice: z.string(),
				probabilities: z.record(z.string(), z.number()),
				confidence: z.number().nullish(),
			}),
			z.object({
				type: z.literal("score"),
				score: z.number(),
				probabilities: z.record(z.string(), z.number()),
				confidence: z.number().nullish(),
			}),
			z.object({ type: z.literal("noul"), noul: z.number() }),
		]),
	),
	usage: z
		.object({
			input_tokens: z.number().nullish(),
			output_tokens: z.number().nullish(),
		})
		.nullish(),
});

type SystemOneAnswer = z.infer<
	typeof systemOneResponseSchema
>["answers"][string];

/** TypeSafe's System One API, served by the gateway at `/typesafe/v1/systemone`. */
export class NeonDecisionModel {
	readonly specificationVersion = "v4";
	readonly supportedQuestionTypes = ["choice", "score", "boolean"] as const;
	readonly modelId: NeonDecisionModelId;
	private readonly config: NeonDecisionModelConfig;

	constructor(modelId: NeonDecisionModelId, config: NeonDecisionModelConfig) {
		this.modelId = modelId;
		this.config = config;
	}

	get provider(): string {
		return this.config.provider;
	}

	async doDecide({
		state,
		questions,
		abortSignal,
		headers,
	}: NeonDecisionCallOptions): Promise<NeonDecisionResult> {
		const {
			value: response,
			rawValue,
			responseHeaders,
		} = await postJsonToApi({
			url: this.config.url(),
			headers: combineHeaders(this.config.headers(), headers),
			body: {
				model: this.modelId,
				state: toSystemOneState(state),
				questions: Object.fromEntries(
					Object.entries(questions).map(([id, question]) => [
						id,
						question.type === "boolean"
							? { ...question, type: "noul" }
							: question,
					]),
				),
			},
			abortSignal,
			fetch: this.config.fetch,
			failedResponseHandler: this.config.failedResponseHandler,
			successfulResponseHandler: createJsonResponseHandler(
				systemOneResponseSchema,
			),
		});

		const confidence: Record<string, number> = {};
		for (const [id, answer] of Object.entries(response.answers)) {
			if (answer.type !== "noul" && answer.confidence != null) {
				confidence[id] = answer.confidence;
			}
		}

		return {
			answers: Object.fromEntries(
				Object.entries(response.answers).map(([id, answer]) => [
					id,
					toDecisionAnswer(answer),
				]),
			),
			usage: {
				inputTokens: response.usage?.input_tokens ?? undefined,
				outputTokens: response.usage?.output_tokens ?? undefined,
			},
			// System One reports probabilities and scores to two decimals.
			rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
			warnings: [],
			providerMetadata: { neon: { confidence } },
			response: {
				modelId: response.model ?? this.modelId,
				headers: responseHeaders,
				body: rawValue,
			},
		};
	}
}

// One JSON part goes as the JSON value itself; anything else is flattened into
// the single string System One accepts.
function toSystemOneState(state: readonly NeonDecisionStatePart[]): unknown {
	const [only] = state;
	if (state.length === 1 && only.type === "json") {
		return only.value;
	}
	return state
		.map((part) => {
			if (part.type === "file") {
				throw new UnsupportedFunctionalityError({
					functionality: "Neon AI Gateway decision file input",
				});
			}
			return part.type === "text"
				? part.text
				: JSON.stringify(part.value);
		})
		.join("\n");
}

function toDecisionAnswer(answer: SystemOneAnswer): NeonDecisionAnswer {
	switch (answer.type) {
		case "noul":
			return { type: "boolean", probability: answer.noul };
		case "choice":
			return {
				type: "choice",
				choice: answer.choice,
				probabilities: answer.probabilities,
			};
		case "score":
			return {
				type: "score",
				score: answer.score,
				probabilities: answer.probabilities,
			};
	}
}
