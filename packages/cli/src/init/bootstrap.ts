import YAML from "yaml";
import { fetchCatalog } from "../templates/catalog.js";
import {
	downloadGithubTemplate,
	type GithubTemplateSource,
	githubDownloadHeaders,
	parseTar as parseGithubTar,
	selectTemplateFiles as selectGithubTemplateFiles,
	type TemplateFile,
} from "../templates/github.js";
import {
	ensureTargetUsable as ensureSharedTargetUsable,
	type MaterializeOptions,
	scaffoldGithubTemplate,
	TemplateInputError,
} from "../templates/scaffold.js";

/**
 * A scaffold template that lives in a subdirectory of a public GitHub repo we
 * control. Bootstrapping copies that subdirectory into a target folder —
 * conceptually the same as `degit user/repo/subdir`, but implemented in-house.
 *
 * The whole template is pulled in a single request: we download the repo's
 * gzipped tarball from `codeload.github.com` and extract only the subdir we
 * want. That endpoint is unauthenticated and is NOT subject to the 60-requests
 * per-hour limit of the REST API (`api.github.com`), so bootstrapping works out
 * of the box on shared/corporate networks without a GITHUB_TOKEN. We lean on
 * `fflate` for gunzip and parse the tar in-house, so we never pull in a heavy
 * dependency tree just to copy a few files.
 */

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

export type BootstrapTemplate = {
	/** Stable id used by `--template` and analytics. */
	id: string;
	/** Human label shown in the interactive selector. */
	title: string;
	/** One-line description shown under the title in the selector. */
	description: string;
	/**
	 * Libraries/frameworks that shape the project (e.g. "Hono", "Drizzle").
	 * Rendered next to the title in the picker so the row reads
	 * "Title (tools)". Optional — older manifests omit it.
	 */
	tools?: string[];
	/**
	 * Neon services the template uses (e.g. "Postgres", "Functions"). Surfaced
	 * alongside the description in the focused row's hint. Optional — older
	 * manifests omit it.
	 */
	services?: string[];
	/** Neon features this template needs (defaults to ["database"]). */
	requires: NeonFeature[];
	source: GithubTemplateSource;
};

/**
 * Hardcoded fallback used when every remote manifest source is unreachable.
 * Kept in sync with `neondatabase/examples/bootstrap.yaml` (the source of
 * truth) so that, even fully offline from the manifest, the picker still offers
 * the full set of starters rather than a single template.
 */
export const FALLBACK_TEMPLATES: BootstrapTemplate[] = [
	{
		id: "hono",
		title: "REST API",
		description:
			"A Hono REST API on Neon Functions, backed by Lakebase Postgres via Drizzle.",
		tools: ["Hono", "Drizzle"],
		services: ["Postgres", "Functions"],
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
		title: "Image-generation agent",
		description:
			"A Vercel AI SDK agent that streams chat through the Neon AI Gateway and stores generated images in Neon object storage, indexed in Postgres via Drizzle.",
		tools: ["AI SDK", "Drizzle"],
		services: ["Postgres", "Functions", "Object Storage", "AI Gateway"],
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
		title: "Personal-assistant agent",
		description:
			"A Mastra agent that streams chat through the Neon AI Gateway and uses Mastra Memory on Lakebase Postgres to remember you across threads.",
		tools: ["Mastra", "Mastra Memory"],
		services: ["Postgres", "Functions", "AI Gateway"],
		requires: ["database", "functions", "ai-gateway"],
		source: {
			owner: "neondatabase",
			repo: "examples",
			ref: "main",
			subdir: "with-mastra",
		},
	},
];

export const templateIds = (templates: BootstrapTemplate[]): string =>
	templates.map((t) => t.id).join(", ");

export const findTemplate = (
	templates: BootstrapTemplate[],
	id: string,
): BootstrapTemplate | undefined => templates.find((t) => t.id === id);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/**
 * Normalize a manifest entry's string list (`tools` or `services`) into a clean
 * array. Tolerant by design: a missing or non-array value yields `undefined`,
 * and non-string/blank items are dropped, so a malformed list never sinks an
 * otherwise-valid template (it just renders without that detail).
 */
const parseStringList = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter(
		(item): item is string =>
			typeof item === "string" && item.trim() !== "",
	);
	return items.length > 0 ? items : undefined;
};

// ---------------------------------------------------------------------------
// Remote template manifest
// ---------------------------------------------------------------------------

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
		// Parse requires — accept a string array, default to ["database"].
		const requires: NeonFeature[] =
			Array.isArray(item.requires) &&
			item.requires.every((r: unknown) => typeof r === "string")
				? (item.requires as NeonFeature[])
				: DEFAULT_REQUIRES;
		const tools = parseStringList(item.tools);
		const services = parseStringList(item.services);
		templates.push({
			id: item.id,
			title: item.title,
			description: item.description,
			...(tools ? { tools } : {}),
			...(services ? { services } : {}),
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
	return fetchCatalog({
		urls: manifestUrls(),
		parse: parseManifest,
		fallback: FALLBACK_TEMPLATES,
		headers: githubDownloadHeaders,
	});
}

// Keep the bootstrap module's public surface while routing all consumers
// through the shared, containment-validating implementation.
export const parseTar = parseGithubTar;
export const selectTemplateFiles = selectGithubTemplateFiles;

/**
 * Download a template and resolve it to the exact set of files to write. The
 * entire subtree is captured in one tarball request, so the copy is atomically
 * consistent: a push to the template repo mid-download cannot produce a
 * mismatched checkout (unlike fetching a file list and then each blob).
 */
export const downloadTemplate = async (
	template: BootstrapTemplate,
): Promise<TemplateFile[]> => {
	return downloadGithubTemplate(template.source);
};

// ---------------------------------------------------------------------------
// Target validation + scaffolding to disk
// ---------------------------------------------------------------------------

/** Backward-compatible bootstrap name for the shared template input error. */
export { TemplateInputError as BootstrapInputError };

/**
 * Ensure `dir` is safe to scaffold into: it must be missing, or an empty
 * directory (a lone `.git` is ignored so you can scaffold into a freshly
 * `git init`ed folder).
 */
export const ensureTargetUsable = ensureSharedTargetUsable;

export type ScaffoldOptions = MaterializeOptions;

/**
 * Download `template` and materialize its files into `targetDir`, creating
 * parent directories, preserving executable bits, and recreating symlinks
 * (with a graceful regular-file fallback on platforms that disallow them).
 * Returns the number of files written. The caller is responsible for any
 * target validation ({@link ensureTargetUsable}) and user-facing progress.
 */
export const scaffoldTemplate = async (
	template: BootstrapTemplate,
	targetDir: string,
	options: ScaffoldOptions = {},
): Promise<number> => {
	return scaffoldGithubTemplate(template.source, targetDir, options);
};
