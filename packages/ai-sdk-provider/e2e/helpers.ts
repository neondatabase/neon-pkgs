/**
 * Representative models from the models.dev `neon` provider — one per gateway route
 * family. See `NEON_MODELS_DEV_IDS` / `NEON_EXTRA_MODEL_IDS` in neon-chat-options.ts.
 */
export const MATRIX_MODELS = {
	/** Native Anthropic Messages API */
	anthropic: "claude-haiku-4-5",
	/** Native OpenAI Responses API */
	openai: "gpt-5-mini",
	/** Native OpenAI Responses API (Codex) */
	codex: "gpt-5-3-codex",
	/** Unified MLflow endpoint (Gemini) */
	google: "gemini-2-5-flash",
	/** Unified MLflow endpoint (Meta) */
	meta: "llama-4-maverick",
} as const;

export type MatrixFamily = keyof typeof MATRIX_MODELS;

/** GPT-5 reasoning models on Responses can consume the whole budget on reasoning tokens. */
export const REASONING_FAMILIES = new Set<MatrixFamily>(["openai", "codex"]);

export function hasGatewayEnv(): boolean {
	const baseUrl = process.env.NEON_AI_GATEWAY_BASE_URL?.trim();
	const token = process.env.NEON_AI_GATEWAY_TOKEN?.trim();
	return Boolean(baseUrl && token);
}

export function assertGatewayEnv(): void {
	if (!hasGatewayEnv()) {
		throw new Error(
			"NEON_AI_GATEWAY_BASE_URL and NEON_AI_GATEWAY_TOKEN are required. " +
				"Create packages/ai-sdk-provider/.env (see .env.example) or export them before running pnpm test:e2e.",
		);
	}
}

export function maxTokensFor(family: MatrixFamily): number {
	return REASONING_FAMILIES.has(family) ? 2048 : 512;
}

/** Dropped-parameter warnings from the provider are expected, not failures. */
export function expectNoHardFailureWarnings(
	warnings: Array<{ type: string }> | undefined,
): void {
	if (!warnings?.length) return;
	for (const warning of warnings) {
		expect(warning.type).not.toBe("other");
	}
}
