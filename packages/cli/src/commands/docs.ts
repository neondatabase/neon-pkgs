import chalk from "chalk";
import type yargs from "yargs";

import { getCliAgent, isCi } from "../env.js";
import { isNetworkError } from "../errors.js";
import { resolveOutputWidth, stripAnsi, truncateTo } from "../human_table.js";
import pkg from "../pkg.js";
import type { CommonProps } from "../types.js";
import { single } from "../utils/flags.js";
import { writer } from "../writer.js";

export const DEFAULT_SITE_SEARCH_URL =
	"https://br-frosty-cell-a5smzg39-assistant.compute.c-1.us-east-2.aws.neon.tech/site-search";

export const SITE_SEARCH_CATEGORIES = [
	"docs",
	"api",
	"postgresql",
	"guides",
	"faqs",
	"blog",
	"changelog",
] as const;

type SiteSearchCategory = (typeof SITE_SEARCH_CATEGORIES)[number];

export const MAX_QUERY_LENGTH = 500;
export const MAX_LIMIT = 40;
const DEFAULT_LIMIT = 10;
const SEARCH_TIMEOUT_MS = 10_000;

export type DocsSearchHit = {
	title: string;
	url: string;
	category: string;
	breadcrumb: string[];
	heading: string;
	excerpt: string;
};

type DocsSearchProps = CommonProps & {
	analytics: boolean;
	query: string;
	category?: SiteSearchCategory[];
	limit: number;
	url?: string;
};

export const command = "docs";
export const describe = "Search neon.com docs, guides, and more";

const SEARCH_DESCRIBE =
	"Search neon.com: docs, API reference, PostgreSQL tutorial, guides, FAQs, changelog, and blog";

export const builder = (argv: yargs.Argv) =>
	argv.usage("$0 docs <sub-command> [options]").command(
		"search <query>",
		SEARCH_DESCRIBE,
		(yargs) =>
			yargs
				.positional("query", {
					describe: "What to search for",
					type: "string",
				})
				.options({
					category: {
						describe:
							"Only return pages in these categories (repeatable)",
						type: "string",
						array: true,
						choices: SITE_SEARCH_CATEGORIES,
					},
					limit: {
						describe: `Maximum number of results (1-${MAX_LIMIT})`,
						type: "number",
						default: DEFAULT_LIMIT,
					},
					url: {
						describe: "Override the site search URL",
						type: "string",
						hidden: true,
						coerce: single("url"),
					},
				})
				.strict()
				.check((args) => {
					const query =
						typeof args.query === "string" ? args.query.trim() : "";
					if (query === "") {
						throw new Error("<query> needs a value");
					}
					if (query.length > MAX_QUERY_LENGTH) {
						throw new Error(
							`<query> must be ${MAX_QUERY_LENGTH} characters or fewer`,
						);
					}
					const limit = args.limit;
					if (
						!Number.isInteger(limit) ||
						limit < 1 ||
						limit > MAX_LIMIT
					) {
						throw new Error(
							`--limit must be a whole number from 1 to ${MAX_LIMIT}`,
						);
					}
					return true;
				})
				.example('$0 docs search "reset a branch"', SEARCH_DESCRIBE)
				.example(
					'$0 docs search "create branch" --category api --category docs',
					"Search only the API reference and the docs",
				),
		(args) => search(args as unknown as DocsSearchProps),
	);

export function resolveSiteSearchUrl(opts: {
	url?: string;
	envUrl?: string;
}): string {
	const fromFlag = opts.url?.trim();
	if (fromFlag) return fromFlag;
	const fromEnv = opts.envUrl?.trim();
	if (fromEnv) return fromEnv;
	return DEFAULT_SITE_SEARCH_URL;
}

const search = async (props: DocsSearchProps) => {
	const query = props.query.trim();
	const hits = await searchSite({
		url: resolveSiteSearchUrl({
			url: props.url,
			envUrl: process.env.NEON_SITE_SEARCH_URL,
		}),
		query,
		limit: props.limit,
		categories: props.category ? [...new Set(props.category)] : undefined,
		headers: siteSearchHeaders({
			analytics: props.analytics,
			agent: getCliAgent(process.env),
			version: pkg.version,
		}),
	});
	const emptyMessage = `No results for "${query}".`;
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(hits, {
			fields: ["title", "heading", "url"],
			emptyMessage,
		});
		return;
	}
	const text = formatSearchResults(hits, {
		emptyMessage,
		width: resolveOutputWidth(process.stdout, undefined, {
			stdout: process.stdout,
			envColumns: process.env.COLUMNS,
		}),
	});
	process.stdout.write(
		process.env.NO_COLOR || isCi() ? stripAnsi(text) : text,
	);
};

// The URL is never cut so it stays copyable and clickable.
export function formatSearchResults(
	hits: DocsSearchHit[],
	opts: { emptyMessage: string; width: number | undefined },
): string {
	if (hits.length === 0) return `\n${opts.emptyMessage}\n`;
	return hits
		.map((hit) => {
			const section = sectionOf(hit).split(" > ").filter(Boolean);
			const line = [hit.title, ...section].join(" › ");
			const shown =
				opts.width === undefined ? line : truncateTo(line, opts.width);
			return `${chalk.bold(shown)}\n  ${chalk.cyan(hit.url)}\n`;
		})
		.join("\n");
}

// Docs headings start with the page title ("Glossary > LSN"); the title column already shows it.
function sectionOf(hit: DocsSearchHit): string {
	const parts = hit.heading.split(" > ");
	return (parts[0] === hit.title ? parts.slice(1) : parts).join(" > ");
}

// neon-agent records each search with its caller; --no-analytics asks it to record nothing.
export function siteSearchHeaders(opts: {
	analytics: boolean;
	agent: string | undefined;
	version: string;
}): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"User-Agent": `neon/${opts.version}`,
		"x-neon-source": "cli",
		...(opts.agent
			? { "x-neon-client": encodeURIComponent(opts.agent) }
			: {}),
		...(opts.analytics ? {} : { "x-neon-analytics": "off" }),
	};
}

function isTimeout(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "TimeoutError" || error.name === "AbortError")
	);
}

async function searchSite(opts: {
	url: string;
	query: string;
	limit: number;
	categories?: SiteSearchCategory[];
	headers: Record<string, string>;
}): Promise<DocsSearchHit[]> {
	const signal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	try {
		const response = await fetch(opts.url, {
			method: "POST",
			headers: opts.headers,
			body: JSON.stringify({
				query: opts.query,
				limit: opts.limit,
				...(opts.categories ? { categories: opts.categories } : {}),
			}),
			signal,
		});
		const raw = await response.text();
		if (!response.ok) {
			throw new Error(searchErrorMessage(raw, response.status));
		}
		return parseSearchHits(raw);
	} catch (error) {
		if (isTimeout(error)) {
			throw new Error("Neon site search did not respond in time.");
		}
		if (isNetworkError(error)) {
			throw new Error(
				"Could not reach Neon site search. Check your internet connection and try again.",
			);
		}
		throw error;
	}
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function searchErrorMessage(raw: string, status: number): string {
	const body = parseJson(raw);
	if (
		status < 500 &&
		typeof body === "object" &&
		body !== null &&
		"error" in body &&
		typeof body.error === "string" &&
		body.error.trim() !== ""
	) {
		return body.error;
	}
	return `Neon site search failed (HTTP ${status}).`;
}

const UNEXPECTED_RESPONSE = "Neon site search returned an unexpected response.";

function stringField(fields: Record<string, unknown>, key: string): string {
	const field = fields[key];
	if (typeof field !== "string") {
		throw new Error(UNEXPECTED_RESPONSE);
	}
	return field;
}

export function parseSearchHits(raw: string): DocsSearchHit[] {
	const body = parseJson(raw);
	if (
		typeof body !== "object" ||
		body === null ||
		!("hits" in body) ||
		!Array.isArray(body.hits)
	) {
		throw new Error(UNEXPECTED_RESPONSE);
	}
	return body.hits.map((hit: unknown): DocsSearchHit => {
		if (typeof hit !== "object" || hit === null) {
			throw new Error(UNEXPECTED_RESPONSE);
		}
		const fields: Record<string, unknown> = Object.fromEntries(
			Object.entries(hit),
		);
		const breadcrumb = fields.breadcrumb;
		if (
			!Array.isArray(breadcrumb) ||
			!breadcrumb.every((part) => typeof part === "string")
		) {
			throw new Error(UNEXPECTED_RESPONSE);
		}
		return {
			title: stringField(fields, "title"),
			url: stringField(fields, "url"),
			category: stringField(fields, "category"),
			breadcrumb,
			heading: stringField(fields, "heading"),
			excerpt: stringField(fields, "excerpt"),
		};
	});
}
