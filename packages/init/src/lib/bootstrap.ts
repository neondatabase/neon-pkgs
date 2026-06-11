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

/** Hardcoded fallback used when the remote manifest cannot be fetched. */
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
];

const MANIFEST_URL =
	"https://raw.githubusercontent.com/neondatabase/examples/main/bootstrap.yaml";

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
 * Fetch the template manifest from the remote bootstrap.yaml in the
 * neondatabase/examples repo. Falls back to the hardcoded list on any error.
 */
export async function fetchTemplates(): Promise<BootstrapTemplate[]> {
	const url = process.env.NEON_BOOTSTRAP_MANIFEST_URL ?? MANIFEST_URL;
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const text = await res.text();
		const templates = parseManifest(text);
		if (templates.length === 0) return FALLBACK_TEMPLATES;
		return templates;
	} catch {
		return FALLBACK_TEMPLATES;
	}
}
