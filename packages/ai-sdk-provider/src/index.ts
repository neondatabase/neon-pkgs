/**
 * `@neon/ai-sdk-provider` — community Vercel AI SDK provider for the
 * Neon AI Gateway.
 *
 * - `createNeon()` / `neon` — the provider. Routes each model to the best
 *   gateway endpoint (Anthropic → native Messages, OpenAI → native Responses
 *   incl. Codex, everything else → unified MLflow).
 */
export { NeonAnthropicLanguageModel } from "./lib/neon-anthropic-language-model.js";
export { NeonChatLanguageModel } from "./lib/neon-chat-language-model.js";
export {
	NEON_EXTRA_MODEL_IDS,
	NEON_MODELS_DEV_IDS,
	type NeonChatModelId,
	type NeonKnownModelId,
} from "./lib/neon-chat-options.js";
export {
	getNeonModelCapabilities,
	getNeonModelRoute,
	type NeonModelCapabilities,
	type NeonModelFamily,
	type NeonModelRoute,
} from "./lib/neon-model-capabilities.js";
export { NeonResponsesLanguageModel } from "./lib/neon-responses-language-model.js";
export {
	createNeon,
	type NeonErrorData,
	type NeonProvider,
	type NeonProviderSettings,
	neon,
} from "./lib/provider.js";
