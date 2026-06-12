import YAML from "yaml";

/**
 * Neon features that a template or project may require.
 * Each feature maps to a setup phase that the orchestrator can run.
 */
export type NeonFeature =
	| "database"
	| "auth"
	| "functions"
	| "ai-gateway"
	| "object-storage";

/** Default features when a template doesn't specify `requires`. */
const DEFAULT_REQUIRES: NeonFeature[] = ["database"];

export interface BootstrapTemplate {
	id: string;
	title: string;
	description: string;
	/** Neon features this template needs (defaults to ["database"]) */
	requires: NeonFeature[];
	source: {
		owner: string;
		repo: string;
		ref: string;
		subdir: string;
	};
}

/**
 * Hardcoded fallback used when every remote manifest source is unreachable.
 * Kept in sync with `neondatabase/examples/bootstrap.yaml` (the source of
 * truth) so that, even fully offline from the manifest, the picker still offers
 * the full set of starters rather than a single template.
 */
export const FALLBACK_TEMPLATES: BootstrapTemplate[] = [
	{
		id: "hono",
		title: "Hono API (Drizzle, Neon Postgres) on Neon Functions",
		description:
			"A Hono API using Drizzle ORM and Neon Postgres, ready to deploy as a Neon Function.",
		requires: ["database", "functions"],
		source: {
			owner: "neondatabase",
			repo: "examples",
			ref: "main",
			subdir: "with-hono",
		},
	},
	{
		id: "ai-sdk",
		title: "AI SDK agent (AI Gateway, object storage, Drizzle) on Neon Functions",
		description:
			"A Vercel AI SDK agent on Neon Functions: streams chat through the Neon AI Gateway, generates an image with OpenAI image generation, and stores it in Neon object storage indexed in Postgres via Drizzle.",
		requires: ["database", "functions", "object-storage", "ai-gateway"],
		source: {
			owner: "neondatabase",
			repo: "examples",
			ref: "main",
			subdir: "with-ai-sdk",
		},
	},
	{
		id: "mastra",
		title: "Mastra personal agent (AI Gateway, Mastra Memory) on Neon Functions",
		description:
			"A Mastra personal-assistant agent on Neon Functions: streams chat through the Neon AI Gateway and uses Mastra Memory — backed by Neon Postgres — to remember the user across conversation threads via resource-scoped working memory.",
		requires: ["database", "functions", "ai-gateway"],
		source: {
			owner: "neondatabase",
			repo: "examples",
			ref: "main",
			subdir: "with-mastra",
		},
	},
];

// Primary manifest host is neon.com (CDN-backed, no GitHub rate limiting), with
// the raw GitHub copy as a fallback and the hardcoded list as the last resort.
// A single env override (used by tests) short-circuits the chain.
const NEON_MANIFEST_URL = "https://neon.com/bootstrap/templates.yaml";
const GITHUB_RAW_MANIFEST_URL =
	"https://raw.githubusercontent.com/neondatabase/examples/main/bootstrap.yaml";

function manifestUrls(): string[] {
	const override = process.env.NEON_BOOTSTRAP_MANIFEST_URL;
	if (override) return [override];
	return [NEON_MANIFEST_URL, GITHUB_RAW_MANIFEST_URL];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

export function parseManifest(text: string): BootstrapTemplate[] {
	const data: unknown = YAML.parse(text);
	if (!isRecord(data) || !Array.isArray(data.templates)) {
		throw new Error(
			'Invalid bootstrap manifest: missing "templates" array.',
		);
	}
	const templates: BootstrapTemplate[] = [];
	for (const item of data.templates) {
		if (
			!isRecord(item) ||
			typeof item.id !== "string" ||
			typeof item.title !== "string" ||
			typeof item.description !== "string" ||
			!isRecord(item.source) ||
			typeof item.source.owner !== "string" ||
			typeof item.source.repo !== "string" ||
			typeof item.source.ref !== "string" ||
			typeof item.source.subdir !== "string"
		) {
			continue;
		}
		// Parse requires — accept string array, default to ["database"]
		const requires: NeonFeature[] =
			Array.isArray(item.requires) &&
			item.requires.every((r: unknown) => typeof r === "string")
				? (item.requires as NeonFeature[])
				: DEFAULT_REQUIRES;

		templates.push({
			id: item.id,
			title: item.title,
			description: item.description,
			requires,
			source: {
				owner: item.source.owner,
				repo: item.source.repo,
				ref: item.source.ref,
				subdir: item.source.subdir,
			},
		});
	}
	return templates;
}

/**
 * Fetch the template manifest, trying each source in {@link manifestUrls} in
 * order and returning the first that yields a non-empty template list. Falls
 * back to the hardcoded list when every source is unreachable or empty, so the
 * picker never fails just because a host is down.
 */
export async function fetchTemplates(): Promise<BootstrapTemplate[]> {
	for (const url of manifestUrls()) {
		try {
			const res = await fetch(url, {
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const templates = parseManifest(await res.text());
			if (templates.length > 0) return templates;
		} catch {
			// Try the next source.
		}
	}
	return FALLBACK_TEMPLATES;
}
