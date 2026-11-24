import { NeonClientError, parseApiPath } from "@neon/sdk";
import {
	describeEndpoint,
	fetchOpenApiSpec,
	NEON_OPENAPI_SPEC_URL,
	type OpenApiSpec,
	searchEndpoints,
} from "@neon/sdk/openapi";
import * as z from "zod";
import { NeonToolCallerError } from "../caller-error.js";
import {
	bindPublicTool,
	bindTool,
	publishedId,
	type ToolClientOptions,
} from "../ergonomic/bind.js";

const SPEC_TTL_MS = 60 * 60 * 1000;

const specCache = new Map<
	string,
	{ spec: Promise<OpenApiSpec>; expiresAt: number }
>();

/**
 * One fetch per URL and hour, shared by concurrent searches. The fetch carries no
 * caller's signal, so one caller cancelling never fails the others; a failed fetch is
 * forgotten so the next search tries again.
 */
const loadSpec = (url: string, fetchImpl: typeof fetch | undefined) => {
	const cached = specCache.get(url);
	if (cached !== undefined && cached.expiresAt > Date.now()) {
		return cached.spec;
	}
	const spec = fetchOpenApiSpec({
		url,
		...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
	});
	specCache.set(url, { spec, expiresAt: Date.now() + SPEC_TTL_MS });
	spec.catch(() => {
		if (specCache.get(url)?.spec === spec) specCache.delete(url);
	});
	return spec;
};

const untilAborted = <T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T> => {
	if (signal === undefined) return promise;
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
};

export const searchApiInputSchema = z.strictObject({
	query: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.describe('What the request should do, e.g. "create branch".'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(20)
		.default(5)
		.describe("Maximum endpoints to return."),
});

const fieldSchema = z.looseObject({
	in: z.string(),
	name: z.string(),
	required: z.boolean(),
	type: z.string(),
	description: z.string(),
});

const searchApiOutputSchema = z.looseObject({
	endpoints: z
		.array(
			z.looseObject({
				method: z.string(),
				path: z.string(),
				summary: z.string(),
				operation_id: z.string(),
				body_required: z.boolean(),
				content_type: z.string(),
				fields: z.array(fieldSchema),
			}),
		)
		.describe(
			"Matching endpoints, best first. Body field names are dotted paths into the JSON body.",
		),
});

export const searchApiTool = (options: ToolClientOptions) => {
	const url = options.apiSpecUrl ?? NEON_OPENAPI_SPEC_URL;
	return bindPublicTool(
		{
			operationId: "api.search",
			id: publishedId("api.search"),
			title: "Search the Neon API",
			description:
				"Finds Neon API endpoints for a task no other tool covers, with the fields {{api.call}} takes.",
			inputSchema: searchApiInputSchema,
			outputSchema: searchApiOutputSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			requiresApproval: false,
			metadata: {
				method: "GET",
				readOnlySafe: true,
				path: "/api_spec/release/v2.json",
				stability: "stable",
				deprecated: false,
				tags: ["API"],
			},
		},
		async ({ query, limit }, context) => {
			const spec = await untilAborted(
				loadSpec(url, options.fetch),
				context.signal,
			);
			return {
				endpoints: searchEndpoints(spec, query, { limit }).map(
					(endpoint) => {
						const described = describeEndpoint(
							spec,
							endpoint.path,
							endpoint.method,
						);
						return {
							method: described.method,
							path: described.path,
							summary: described.summary,
							operation_id: described.operationId,
							body_required: described.bodyRequired,
							content_type: described.contentType,
							fields: described.fields,
						};
					},
				),
			};
		},
	);
};

const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export const callApiInputSchema = z.strictObject({
	method: z.enum(API_METHODS).describe("The HTTP method."),
	path: z
		.string()
		.min(1)
		.max(2000)
		.describe(
			"A path from {{api.search}} with each {placeholder} filled in.",
		),
	query: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
		.optional()
		.describe("Query parameters."),
	body: z
		.unknown()
		.optional()
		.describe("The JSON body, nested as the API expects."),
});

const callApiOutputSchema = z
	.unknown()
	.describe("The response body: JSON, text, or null when empty.");

/** Neon Auth routes are where stored secrets (OAuth provider client secrets, the SMTP password) come back. */
const reachesStoredSecrets = (segments: readonly string[]) =>
	segments.some((segment) => segment.toLowerCase() === "auth");

export const callApiTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "api.call",
			id: publishedId("api.call"),
			title: "Call the Neon API",
			description:
				"Sends one request to any Neon API endpoint, for a task no other tool covers; find it with {{api.search}} first. NEVER run a write autonomously: run it only when the user's own message asks for it and unambiguously identifies its target; otherwise ask first.",
			inputSchema: callApiInputSchema,
			outputSchema: callApiOutputSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true,
			},
			requiresApproval: true,
			metadata: {
				method: "*",
				readOnlySafe: false,
				path: "/*",
				stability: "stable",
				deprecated: false,
				tags: ["API"],
				secretOutputFields: [{ path: "$", kind: "setup" }],
				returnsOnlySecrets: true,
			},
		},
		async (neon, { method, path, query, body }, signal, context) => {
			const segments = parseApiPath(path);
			if (segments instanceof NeonClientError) {
				throw segments;
			}
			if (
				(context.secrets ?? "all") !== "all" &&
				reachesStoredSecrets(segments)
			) {
				throw new NeonToolCallerError(
					`${publishedId("api.call")} cannot reach Neon Auth routes on this connection because they return stored secrets, such as OAuth provider client secrets and the SMTP password. Use the Neon Auth tools, which hide them.`,
				);
			}
			return neon.request(
				{
					method,
					path,
					...(query === undefined ? {} : { query }),
					...(body === undefined ? {} : { body }),
				},
				{ signal },
			);
		},
	);
