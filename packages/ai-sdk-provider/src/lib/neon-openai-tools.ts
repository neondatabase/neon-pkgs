import { openai as openaiProvider } from "@ai-sdk/openai";
import { UnsupportedFunctionalityError } from "@ai-sdk/provider";
import { z } from "zod/v4";

export type NeonImageGenerationArgs = {
	background?: "auto" | "opaque" | "transparent";
	inputFidelity?: "low" | "high";
	inputImageMask?: {
		fileId?: string;
		imageUrl?: string;
	};
	/** Image model. Defaults to `gpt-image-2`; `gpt-image-1` is rejected. */
	model?: string;
	moderation?: "auto";
	outputCompression?: number;
	outputFormat?: "png" | "jpeg" | "webp";
	partialImages?: number;
	quality?: "auto" | "low" | "medium" | "high";
	size?: "auto" | "1024x1024" | "1024x1536" | "1536x1024";
};

const DEFAULT_IMAGE_MODEL = "gpt-image-2";

const imageGenerationInputSchema = z.object({});
const imageGenerationOutputSchema = z.object({ result: z.string() });

/**
 * OpenAI image generation tool with a schema shape shared by AI SDK 6 and 7.
 *
 * AI SDK 6's official factory wraps schemas in its version-specific `Schema`
 * type. AI SDK 7 can execute the resulting object, but rejects that type at
 * compile time. Raw Zod 4 schemas implement the shared Standard Schema
 * interface accepted by both SDK versions.
 */
export function imageGeneration(args: NeonImageGenerationArgs = {}) {
	if (args.model === "gpt-image-1") {
		throw new UnsupportedFunctionalityError({
			functionality: "image generation with gpt-image-1",
			message:
				"OpenAI has deprecated `gpt-image-1`, so image generation with it " +
				"fails on the Neon AI Gateway. Use `gpt-image-2`, which " +
				"`neon.tools.imageGeneration()` uses when `model` is omitted.",
		});
	}

	const type: "provider" = "provider";
	const id: "openai.image_generation" = "openai.image_generation";
	const isProviderExecuted: true = true;

	return {
		type,
		id,
		args: { ...args, model: args.model ?? DEFAULT_IMAGE_MODEL },
		inputSchema: imageGenerationInputSchema,
		outputSchema: imageGenerationOutputSchema,
		isProviderExecuted,
	};
}

export type NeonOpenAITools = Omit<
	typeof openaiProvider.tools,
	"imageGeneration"
> & {
	imageGeneration: typeof imageGeneration;
};

export const neonOpenAITools: NeonOpenAITools = {
	...openaiProvider.tools,
	imageGeneration,
};
