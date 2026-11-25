import { OpenAICompatibleChatLanguageModel } from "@ai-sdk/openai-compatible";
import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
	LanguageModelV3StreamPart,
	LanguageModelV3StreamResult,
} from "@ai-sdk/provider";
import {
	applyNeonCapabilities,
	mergeStreamStartWarnings,
} from "./neon-capabilities.js";
import { firstChoiceField, imageFilesFrom } from "./neon-harmony-normalize.js";

/**
 * Language model for the Neon AI Gateway unified (MLflow) endpoint.
 *
 * Used for every model that is not routed to a provider-native endpoint
 * (Gemini, Llama, Qwen, gpt-oss, ...). It is a thin specialization of the shared
 * OpenAI-compatible chat model that adds per-model capability handling:
 * parameters an upstream backend is known to reject are dropped and reported as
 * warnings instead of failing the request.
 *
 * It also returns the images the Gemini image models generate as file parts
 * (`result.files`), which the shared model has no field for.
 */
export class NeonChatLanguageModel
	extends OpenAICompatibleChatLanguageModel
	implements LanguageModelV3
{
	override async doGenerate(
		options: LanguageModelV3CallOptions,
	): Promise<LanguageModelV3GenerateResult> {
		const { options: adjusted, warnings } = applyNeonCapabilities(
			this.modelId,
			options,
		);
		const result = await super.doGenerate(adjusted);
		const files = imageFilesFrom(
			firstChoiceField(result.response?.body, "message"),
		);
		return {
			...result,
			content:
				files.length > 0
					? [...result.content, ...files]
					: result.content,
			warnings:
				warnings.length > 0
					? [...warnings, ...result.warnings]
					: result.warnings,
		};
	}

	override async doStream(
		options: LanguageModelV3CallOptions,
	): Promise<LanguageModelV3StreamResult> {
		const { options: adjusted, warnings } = applyNeonCapabilities(
			this.modelId,
			options,
		);
		// Images only reach us on the raw chunk, so raw chunks are always requested and
		// forwarded only when the caller asked for them.
		const result = await super.doStream({
			...adjusted,
			includeRawChunks: true,
		});
		const stream = result.stream.pipeThrough(
			emitImageFiles(options.includeRawChunks === true),
		);
		return {
			...result,
			stream:
				warnings.length > 0
					? stream.pipeThrough(mergeStreamStartWarnings(warnings))
					: stream,
		};
	}
}

function emitImageFiles(
	forwardRawChunks: boolean,
): TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart> {
	return new TransformStream({
		transform(part, controller) {
			if (part.type !== "raw") {
				controller.enqueue(part);
				return;
			}
			if (forwardRawChunks) controller.enqueue(part);
			for (const file of imageFilesFrom(
				firstChoiceField(part.rawValue, "delta"),
			)) {
				controller.enqueue(file);
			}
		},
	});
}
