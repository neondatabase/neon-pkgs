import { NeonClientError } from "@neon/sdk";
import * as z from "zod";
import {
	bindPublicTool,
	publishedId,
	type ToolClientOptions,
} from "../ergonomic/bind.js";
import type { NeonToolAnnotations, NeonToolCaller } from "../operation.js";

export const DEFAULT_SITE_SEARCH_URL =
	"https://br-frosty-cell-a5smzg39-assistant.compute.c-1.us-east-2.aws.neon.tech/site-search";
export const DEFAULT_DOCS_BASE_URL = "https://neon.com";

// A stalled upstream must not hold the caller for the host's whole tool timeout.
export const UPSTREAM_TIMEOUT_MS = 10_000;

export const upstreamSignal = (signal?: AbortSignal) => {
	const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
	return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
};

const docsAnnotations: NeonToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};

const SITE_SEARCH_CATEGORIES = [
	"docs",
	"api",
	"postgresql",
	"guides",
	"faqs",
	"blog",
	"changelog",
] as const;

export const searchDocsInputSchema = z.strictObject({
	query: z
		.string()
		.trim()
		.min(1)
		.max(500)
		.describe(
			'What to search for, in words, e.g. "reset a branch" or "connection pooling".',
		),
	categories: z
		.array(z.enum(SITE_SEARCH_CATEGORIES))
		.min(1)
		.max(SITE_SEARCH_CATEGORIES.length)
		.refine((values) => new Set(values).size === values.length, {
			message: "categories must not repeat a value",
		})
		.optional()
		.describe(
			"Only return pages in these categories: docs, api (API reference), postgresql (PostgreSQL tutorial), guides, faqs, blog, changelog. Omit to search everything.",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(40)
		.default(10)
		.describe("Maximum number of pages to return (1-40)."),
});

export const getDocInputSchema = z.strictObject({
	slug: z
		.string()
		.describe(
			"The slug of a hit returned by docs.search, e.g. 'docs/guides/prisma' or 'postgresql/tutorial/inner-join'.",
		),
});

const UNEXPECTED_SEARCH_RESPONSE =
	"Neon site search returned an unexpected response";

// Unknown keys (score, collection) are stripped; they are not part of the tool result.
const searchDocsResponseSchema = z.object({
	hits: z.array(
		z.object({
			title: z.string(),
			url: z.string(),
			slug: z.string(),
			category: z.string(),
			breadcrumb: z.array(z.string()),
			heading: z.string(),
			excerpt: z.string(),
		}),
	),
});

const upstreamError = (body: unknown): string | undefined => {
	if (typeof body !== "object" || body === null || !("error" in body)) {
		return undefined;
	}
	return typeof body.error === "string" && body.error.trim() !== ""
		? body.error
		: undefined;
};

const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

const DEFAULT_CALLER_SOURCE = "neon_tools";

/**
 * The search service records each search by caller. A source that cannot be a
 * header falls back to the default; a user agent or client that cannot is dropped.
 */
export const searchDocsHeaders = (
	caller: NeonToolCaller | undefined,
): Record<string, string> => {
	const source = caller?.source.trim().slice(0, 100);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"x-caller-source":
			source && PRINTABLE_ASCII.test(source)
				? source
				: DEFAULT_CALLER_SOURCE,
	};
	const userAgent = caller?.userAgent?.trim().slice(0, 512);
	if (userAgent && PRINTABLE_ASCII.test(userAgent)) {
		headers["x-caller-user-agent"] = userAgent;
	}
	const client = caller?.client?.trim().slice(0, 100);
	if (client && client !== "unknown") {
		headers["x-caller-client"] = encodeURIComponent(client);
	}
	return headers;
};

const validateDocSlug = (slug: string) => {
	if (slug.includes("..")) {
		throw new NeonClientError(
			'Invalid doc slug: path traversal ("..") is not allowed',
		);
	}
	if (slug.includes("://")) {
		throw new NeonClientError(
			"Invalid doc slug: absolute URLs are not allowed",
		);
	}
	if (slug.startsWith("/")) {
		throw new NeonClientError(
			'Invalid doc slug: slug must not start with "/"',
		);
	}
};

export const searchDocsTool = (options: ToolClientOptions) => {
	const url = options.siteSearchUrl ?? DEFAULT_SITE_SEARCH_URL;
	const fetchImpl = options.fetch ?? fetch;
	return bindPublicTool(
		{
			operationId: "docs.search",
			id: publishedId("docs.search"),
			title: "Search Documentation",
			description:
				"Search neon.com: docs, API reference, PostgreSQL tutorial, guides, FAQs, changelog, and blog. Returns ranked pages with title, URL, the matching section, and a slug; read a full page with docs.get.",
			inputSchema: searchDocsInputSchema,
			annotations: docsAnnotations,
			requiresApproval: false,
			metadata: {
				method: "POST",
				path: "/site-search",
				stability: "stable",
				deprecated: false,
				tags: ["Docs"],
			},
		},
		async (input, context) => {
			const response = await fetchImpl(url, {
				method: "POST",
				headers: searchDocsHeaders(context.caller),
				body: JSON.stringify(input),
				signal: upstreamSignal(context.signal),
			});
			const raw = await response.text();
			let body: unknown;
			try {
				body = JSON.parse(raw);
			} catch {
				throw new Error(
					`${UNEXPECTED_SEARCH_RESPONSE}: HTTP ${response.status}, body is not JSON`,
				);
			}
			if (response.status === 400) {
				throw new NeonClientError(
					upstreamError(body) ??
						"Neon site search rejected the request",
				);
			}
			if (!response.ok) {
				throw new Error(
					`Neon site search failed: HTTP ${response.status}`,
				);
			}
			const parsed = searchDocsResponseSchema.safeParse(body);
			if (!parsed.success) {
				const issue = parsed.error.issues[0];
				throw new Error(
					`${UNEXPECTED_SEARCH_RESPONSE}: ${issue?.path.join(".")} ${issue?.message}`,
				);
			}
			return parsed.data;
		},
	);
};

export const getDocTool = (options: ToolClientOptions) => {
	const baseUrl = options.docsBaseUrl ?? DEFAULT_DOCS_BASE_URL;
	const fetchImpl = options.fetch ?? fetch;
	return bindPublicTool(
		{
			operationId: "docs.get",
			id: publishedId("docs.get"),
			title: "Get Documentation Page",
			description:
				"Fetch one neon.com page as markdown. Pass the slug of a docs.search hit (for example docs/guides/prisma). Returns `{ url, markdown }`.",
			inputSchema: getDocInputSchema,
			annotations: docsAnnotations,
			requiresApproval: false,
			metadata: {
				method: "GET",
				path: "/{slug}.md",
				stability: "stable",
				deprecated: false,
				tags: ["Docs"],
			},
		},
		async ({ slug }, context) => {
			validateDocSlug(slug);
			const mdSlug = slug.endsWith(".md") ? slug : `${slug}.md`;
			const url = `${baseUrl}/${mdSlug}`;
			const response = await fetchImpl(url, {
				signal: upstreamSignal(context.signal),
			});
			if (response.status === 404) {
				throw new NeonClientError(
					`Doc page not found: "${mdSlug}". Pass a slug returned by docs.search.`,
				);
			}
			if (!response.ok) {
				throw new Error(
					`Failed to fetch doc page "${mdSlug}": ${response.status} ${response.statusText}`,
				);
			}
			return { url, markdown: await response.text() };
		},
	);
};
