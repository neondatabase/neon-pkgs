import {
	type BucketObjectsListResponse,
	createNeonClient,
	type NeonClient,
	type NeonConfig,
	NeonError,
	type Paginated,
} from "@neon/sdk";
import * as z from "zod";
import {
	type NeonOperationId,
	operationFactories,
} from "../../operations.gen.js";
import {
	missingBearerCredential,
	type NeonBearerCredential,
	requireBearerCredential,
} from "../auth.js";
import type {
	JsonSafe,
	NeonTool,
	NeonToolAnnotations,
	NeonToolExecutionContext,
} from "../operation.js";
import { toToolResult } from "../result.js";
import type { NeonToolId } from "./ids.js";

export interface ToolClientOptions {
	apiKey?: NeonBearerCredential;
	baseUrl?: string;
	fetch?: typeof fetch;
	wait?: NeonConfig["wait"];
}

const ALL_PAGES = " This tool returns every page. Do not pass a cursor.";

const inertClient = createNeonClient({
	apiKey: "unused",
}).client;

type Snake<S extends string> = S extends `${infer Head}${infer Rest}`
	? Head extends Uppercase<Head>
		? Head extends Lowercase<Head>
			? `${Head}${Snake<Rest>}`
			: `_${Lowercase<Head>}${Snake<Rest>}`
		: `${Head}${Snake<Rest>}`
	: S;

export type PublishedId<Id extends string> =
	Id extends `${infer Head}.${infer Rest}`
		? `${Snake<Head>}_${PublishedId<Rest>}`
		: Snake<Id>;

export const publishedId = <Id extends string>(id: Id): PublishedId<Id> =>
	id
		.split(".")
		.map((segment) =>
			segment.replace(
				/[A-Z]/g,
				(character) => `_${character.toLowerCase()}`,
			),
		)
		.join("_") as PublishedId<Id>;

const resolveApiKey = (
	options: ToolClientOptions,
	context?: NeonToolExecutionContext,
): NeonBearerCredential => {
	if (context !== undefined && "apiKey" in context) {
		if (context.apiKey === undefined) {
			throw new TypeError(
				"A Neon API key or OAuth access token is required",
			);
		}
		return requireBearerCredential(context.apiKey);
	}
	return options.apiKey === undefined
		? missingBearerCredential
		: requireBearerCredential(options.apiKey);
};

export const toolClient = (
	options: ToolClientOptions,
	context?: NeonToolExecutionContext,
): NeonClient<true> =>
	createNeonClient({
		apiKey: resolveApiKey(options, context),
		throwOnError: true,
		waitForReadiness: true,
		...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
		...(options.wait === undefined ? {} : { wait: options.wait }),
	});

const objectListPage = (
	value:
		| BucketObjectsListResponse
		| { error?: unknown; data?: BucketObjectsListResponse },
): BucketObjectsListResponse => {
	if ("objects" in value && "folders" in value) {
		return value;
	}
	if ("error" in value && value.error !== undefined) {
		throw value.error;
	}
	if ("data" in value && value.data !== undefined) {
		return value.data;
	}
	throw new NeonError("Object list returned no data.", "client");
};

export const collectObjectList = async (
	neon: NeonClient<true>,
	input: {
		project_id: string;
		branch_id: string;
		bucket_name: string;
		prefix?: string;
		delimiter?: string;
		limit?: number;
	},
	signal?: AbortSignal,
) => {
	const folders: string[] = [];
	const objects: BucketObjectsListResponse["objects"] = [];
	let prefix = "";
	let cursor: string | undefined;
	for (;;) {
		const page = objectListPage(
			await neon.storage.objects.list(
				input.project_id,
				input.branch_id,
				input.bucket_name,
				{
					...(input.prefix === undefined
						? {}
						: { prefix: input.prefix }),
					...(input.delimiter === undefined
						? {}
						: { delimiter: input.delimiter }),
					...(input.limit === undefined
						? {}
						: { limit: input.limit }),
					...(cursor === undefined ? {} : { cursor }),
				},
				{ signal },
			),
		);
		folders.push(...page.folders);
		objects.push(...page.objects);
		prefix = page.prefix;
		if (page.next_cursor) {
			cursor = page.next_cursor;
			continue;
		}
		if (page.is_truncated) {
			throw new NeonError(
				"Object list was truncated without a next cursor.",
				"client",
			);
		}
		break;
	}
	return { folders, objects, prefix };
};

export const collectPages = async <T>(list: Paginated<T>): Promise<T[]> => {
	const result = await list.all();
	if (result.error) {
		throw result.error;
	}
	if (result.data === undefined) {
		throw new NeonError("List returned no data.", "client");
	}
	return result.data;
};

export const bindTool = <
	const InputSchema extends z.ZodType,
	const Id extends string,
	Output,
>(
	options: ToolClientOptions,
	tool: Omit<NeonTool<InputSchema, Id, JsonSafe<Awaited<Output>>>, "execute">,
	run: (
		neon: NeonClient<true>,
		input: z.output<InputSchema>,
		signal?: AbortSignal,
	) => Promise<Output>,
): NeonTool<InputSchema, Id, JsonSafe<Awaited<Output>>> => ({
	...tool,
	async execute(input, context) {
		const parsed = await tool.inputSchema.parseAsync(input);
		const result = await run(
			toolClient(options, context),
			parsed,
			context?.signal,
		);
		return toToolResult(result);
	},
});

type GeneratedTool<G extends NeonOperationId> = ReturnType<
	(typeof operationFactories)[G]
>;
type GeneratedSchema<G extends NeonOperationId> =
	GeneratedTool<G>["inputSchema"];
type GeneratedInput<G extends NeonOperationId> = z.output<GeneratedSchema<G>>;
type GeneratedArg<G extends NeonOperationId> = z.input<GeneratedSchema<G>>;

type FromGeneratedMeta = {
	list?: boolean;
	annotations?: NeonToolAnnotations;
	requiresApproval?: boolean;
};

type OmittedInput<G extends NeonOperationId, Keys extends string> = Omit<
	GeneratedInput<G>,
	Keys
>;
type OmittedArg<G extends NeonOperationId, Keys extends string> = Omit<
	GeneratedArg<G>,
	Keys
>;

export function fromGenerated<
	const Id extends NeonToolId,
	const G extends NeonOperationId,
	Output,
>(
	options: ToolClientOptions,
	spec: FromGeneratedMeta & {
		id: Id;
		generated: G;
		run: (
			neon: NeonClient<true>,
			input: GeneratedInput<G>,
			signal?: AbortSignal,
		) => Promise<Output>;
	},
): NeonTool<GeneratedSchema<G>, PublishedId<Id>, JsonSafe<Awaited<Output>>>;
export function fromGenerated<
	const Id extends NeonToolId,
	const G extends NeonOperationId,
	const Keys extends keyof GeneratedInput<G> & string,
	Output,
>(
	options: ToolClientOptions,
	spec: FromGeneratedMeta & {
		id: Id;
		generated: G;
		omit: readonly Keys[];
		run: (
			neon: NeonClient<true>,
			input: OmittedInput<G, Keys>,
			signal?: AbortSignal,
		) => Promise<Output>;
	},
): NeonTool<
	z.ZodType<OmittedInput<G, Keys>, OmittedArg<G, Keys>>,
	PublishedId<Id>,
	JsonSafe<Awaited<Output>>
>;
export function fromGenerated(
	options: ToolClientOptions,
	spec: FromGeneratedMeta & {
		id: NeonToolId;
		generated: NeonOperationId;
		omit?: readonly string[];
		run: (
			neon: NeonClient<true>,
			input: never,
			signal?: AbortSignal,
		) => Promise<unknown>;
	},
): NeonTool {
	const generated = operationFactories[spec.generated](inertClient);
	const schema = generated.inputSchema;
	const inputSchema =
		spec.omit === undefined || spec.omit.length === 0
			? schema
			: omitObjectKeys(schema, spec.omit);
	return {
		operationId: spec.id,
		id: publishedId(spec.id),
		title: generated.title,
		description: spec.list
			? `${generated.description.trimEnd()}${ALL_PAGES}`
			: generated.description,
		inputSchema,
		annotations: spec.annotations ?? generated.annotations,
		requiresApproval: spec.requiresApproval ?? generated.requiresApproval,
		metadata: generated.metadata,
		async execute(input, context) {
			const parsed = await inputSchema.parseAsync(input);
			const result = await spec.run(
				toolClient(options, context),
				parsed as never,
				context?.signal,
			);
			return toToolResult(result);
		},
	};
}

const omitObjectKeys = (
	schema: z.ZodType,
	keys: readonly string[],
): z.ZodType => {
	if (!(schema instanceof z.ZodObject)) {
		throw new TypeError("Generated tool input schemas must be objects");
	}
	const mask: Record<string, true> = {};
	for (const key of keys) {
		mask[key] = true;
	}
	return schema.omit(mask);
};
