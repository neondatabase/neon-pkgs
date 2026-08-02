/**
 * Representative models from the models.dev `neon` provider — one per gateway route
 * family. See `NEON_MODELS_DEV_IDS` / `NEON_EXTRA_MODEL_IDS` in neon-chat-options.ts.
 */
import { expect } from "vitest";

export const MATRIX_MODELS = {
	/** Native Anthropic Messages API */
	anthropic: "claude-haiku-4-5",
	/** Native OpenAI Responses API */
	openai: "gpt-5-mini",
	/** Native OpenAI Responses API (Codex) */
	codex: "gpt-5-3-codex",
	/** Unified MLflow endpoint (Gemini) */
	google: "gemini-3-flash",
	/** Unified MLflow endpoint (Meta) */
	meta: "llama-4-maverick",
	/** Unified MLflow endpoint (Alibaba) */
	alibaba: "qwen3-next-80b-a3b-instruct",
} as const;

export type MatrixFamily = keyof typeof MATRIX_MODELS;

/**
 * Reasoning models spend the output budget on reasoning tokens before emitting
 * any text, so these families get a larger one.
 *
 * `qwen35-122b-a10b` is deliberately not the Alibaba representative: it reasons
 * its way through the whole budget on these terse prompts often enough to be
 * flaky at 2048 and at 4096, which would make the matrix a coin flip rather
 * than a regression signal.
 */
export const REASONING_FAMILIES = new Set<MatrixFamily>(["openai", "codex"]);

/** Families whose route forwards the OpenAI `reasoningEffort` provider option. */
export const REASONING_EFFORT_FAMILIES = new Set<MatrixFamily>([
	"openai",
	"codex",
]);

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

/**
 * Model ids the branch under test actually serves.
 *
 * The catalog is per-account during the beta — an account can be paid and still
 * see a trimmed list, and models come and go (all Anthropic ids are absent at
 * the time of writing). A matrix pinned to ids alone therefore goes red for
 * reasons that have nothing to do with this provider, which is exactly the
 * signal we want to keep clean. Families whose representative id is missing are
 * skipped instead, so the suite reports "not served here" rather than a
 * failure.
 */
export async function fetchServedModelIds(): Promise<Set<string>> {
	const baseUrl = process.env.NEON_AI_GATEWAY_BASE_URL?.trim().replace(
		/\/+$/,
		"",
	);
	const response = await fetch(`${baseUrl}/v1/models`, {
		headers: {
			Authorization: `Bearer ${process.env.NEON_AI_GATEWAY_TOKEN}`,
		},
	});
	if (!response.ok) {
		throw new Error(
			`GET /v1/models returned ${response.status} ${response.statusText}`,
		);
	}
	const data = (await response.json()) as {
		data?: Array<{ id: string; enabled?: boolean }>;
	};
	if (!data.data?.length) {
		throw new Error("GET /v1/models returned an empty catalog");
	}
	return new Set(
		data.data.filter((model) => model.enabled !== false).map((m) => m.id),
	);
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
