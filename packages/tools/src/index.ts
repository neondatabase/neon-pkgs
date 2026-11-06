import { NeonError } from "@neon/sdk";
import {
	applyToolCustomization,
	assertToolCustomizeOptions,
	hasToolCustomization,
	type InjectedNeonTool,
	type NeonToolCustomizeOptions,
	type NeonToolInjectOptions,
	type NeonToolNameOverrides,
} from "./lib/customize.js";
import {
	isNeonToolId,
	type NeonToolId,
	type PublishedId,
	publishedId,
	type ToolClientOptions,
	type ToolFactory,
	toolFactories,
	toolIds,
	unpublishedToolError,
} from "./lib/ergonomic/index.js";
import type { NeonTool, NeonToolResult } from "./lib/operation.js";

export type { NeonBearerCredential } from "./lib/auth.js";
export type {
	InjectedNeonTool,
	NeonToolCustomizeOptions,
	NeonToolDescriptionOverrides,
	NeonToolDescriptionSource,
	NeonToolInjectOptions,
	NeonToolInjectValue,
	NeonToolNameOverrides,
	NeonToolNameSource,
	NeonToolOnExecute,
	NeonToolOnExecuteEvent,
} from "./lib/customize.js";
export type {
	JsonSafe,
	JsonSafeBlob,
	NeonExecutableTool,
	NeonTool,
	NeonToolAnnotations,
	NeonToolExecutionContext,
	NeonToolMetadata,
	NeonToolResult,
} from "./lib/operation.js";
export type { NeonToolId, PublishedId };
export { NeonError, publishedId, toolIds };

type ToolFactories = typeof toolFactories;

type ThrowsFrom<T> = T extends { throwOnError: false }
	? false
	: T extends { throwOnError: true }
		? true
		: "throwOnError" extends keyof T
			? boolean
			: true;

type WithThrowMode<Tool, Throws extends boolean> = Tool extends {
	execute: (
		input: infer Input,
		context?: infer Context,
	) => Promise<{ data: infer Data }>;
}
	? Omit<Tool, "execute"> & {
			execute(
				input: Input,
				context?: Context,
			): Promise<NeonToolResult<Data, Throws>>;
		}
	: Tool;

type ToolsWithThrow<Tools, Throws extends boolean> = {
	[Key in keyof Tools]: WithThrowMode<Tools[Key], Throws>;
};

export type NeonTools<Tools extends readonly NeonToolId[] = []> = {
	[Tool in Tools[number]]: ReturnType<ToolFactories[Tool]>;
};

export type InjectedNeonTools<Tools extends readonly NeonToolId[], Inject> = {
	[Tool in Tools[number]]: InjectedNeonTool<
		ReturnType<ToolFactories[Tool]>,
		Inject
	>;
};

type WithPublishedId<Tool> = Tool extends { id: string }
	? Omit<Tool, "id"> & { id: string }
	: Tool;

export interface NeonToolsClientOptions
	extends ToolClientOptions,
		Omit<NeonToolCustomizeOptions, "name" | "names"> {}

type CreateNeonToolsInput = NeonToolsClientOptions & {
	tools: readonly NeonToolId[];
};

export type CreateNeonToolsOptions<
	Tools extends readonly NeonToolId[] = readonly NeonToolId[],
> = NeonToolsClientOptions & { tools: Tools };

type SelectedTools<T> = T extends {
	tools: infer S extends readonly NeonToolId[];
}
	? S
	: [];

type NeonToolsFor<T, Inject> = T extends CreateNeonToolsInput
	? ToolsWithThrow<
			Inject extends NeonToolInjectOptions
				? InjectedNeonTools<SelectedTools<T>, Inject>
				: NeonTools<SelectedTools<T>>,
			ThrowsFrom<T>
		>
	: never;

type ToolForId<Id extends NeonToolId> = ReturnType<ToolFactories[Id]>;

type BindableToolsInput<T extends CreateNeonToolsInput> = T & {
	name?: (id: string) => string;
	names?: NeonToolNameOverrides;
};

const assertKnownNameKeys = (
	names: NeonToolNameOverrides | undefined,
	tools: ReadonlyArray<{ operationId: string; id: string }>,
): void => {
	if (names === undefined || typeof names === "function") {
		return;
	}
	const known = new Set(tools.flatMap((tool) => [tool.operationId, tool.id]));
	const unknown = Object.keys(names).filter((key) => !known.has(key));
	if (unknown.length > 0) {
		throw new TypeError(
			`Unknown Neon tool name override: ${unknown.join(", ")}`,
		);
	}
};

function assertNeonTools<Tools extends readonly NeonToolId[]>(
	value: unknown,
	tools: Tools,
): asserts value is NeonTools<Tools> {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("Expected Neon tools to be an object.");
	}
	for (const toolId of tools) {
		if (!(toolId in value)) {
			throw new TypeError(`Missing Neon tool "${toolId}".`);
		}
	}
}

const factoryFor = (id: NeonToolId): ToolFactory => {
	const known = toolIds.find((candidate) => candidate === id);
	if (known === undefined) {
		throw unpublishedToolError(id);
	}
	return toolFactories[known];
};

const bindTools = <T extends CreateNeonToolsInput>(
	options: BindableToolsInput<T>,
): NeonTools<SelectedTools<T>> => {
	assertToolCustomizeOptions(options);
	const selected = options.tools;
	if (selected === undefined || selected.length === 0) {
		throw new TypeError("createNeonTools requires at least one tool");
	}

	const seen = new Set<NeonToolId>();
	const rawEntries = selected.map((toolId) => {
		if (seen.has(toolId)) {
			throw new Error(`Duplicate Neon tool "${toolId}"`);
		}
		seen.add(toolId);
		return [toolId, factoryFor(toolId)(options)] as const;
	});

	assertKnownNameKeys(
		options.names,
		rawEntries.map(([, tool]) => tool),
	);
	const entries = rawEntries.map(([id, tool]) => {
		return [
			id,
			hasToolCustomization(options)
				? applyToolCustomization(tool, options)
				: tool,
		] as const;
	});
	const publishedIds = new Map<string, string>();
	for (const [id, tool] of entries) {
		const previous = publishedIds.get(tool.id);
		if (previous !== undefined) {
			throw new Error(
				`Duplicate Neon tool id "${tool.id}" for ${previous}, ${id}`,
			);
		}
		publishedIds.set(tool.id, id);
	}
	const tools: unknown = Object.fromEntries(entries);
	assertNeonTools(tools, selected);
	if (options.throwOnError === false) {
		const enveloped = Object.fromEntries(
			Object.entries(tools as Record<string, NeonTool>).map(
				([id, tool]) => [
					id,
					{
						...tool,
						execute: envelopeExecute(tool.execute.bind(tool)),
					},
				],
			),
		);
		assertNeonTools(enveloped, selected);
		return enveloped as NeonTools<SelectedTools<T>>;
	}
	return tools as NeonTools<SelectedTools<T>>;
};

const envelopeExecute = (execute: NeonTool["execute"]): NeonTool["execute"] =>
	(async (input, context) => {
		try {
			return await execute(input, context);
		} catch (error) {
			if (!(error instanceof NeonError)) {
				throw error;
			}
			return { error };
		}
	}) as NeonTool["execute"];

type NamedNeonTools<
	Tools extends readonly NeonToolId[],
	Inject,
	Throws extends boolean,
> = {
	[Tool in Tools[number]]: WithPublishedId<
		WithThrowMode<
			Inject extends NeonToolInjectOptions
				? InjectedNeonTool<ReturnType<ToolFactories[Tool]>, Inject>
				: ReturnType<ToolFactories[Tool]>,
			Throws
		>
	>;
};

type NamedNeonTool<
	Id extends NeonToolId,
	Inject,
	Throws extends boolean,
> = WithPublishedId<
	WithThrowMode<
		Inject extends NeonToolInjectOptions
			? InjectedNeonTool<ToolForId<Id>, Inject>
			: ToolForId<Id>,
		Throws
	>
>;

type NamedNeonToolsFor<T, Inject> = T extends CreateNeonToolsInput
	? NamedNeonTools<SelectedTools<T>, Inject, ThrowsFrom<T>>
	: never;

export function createNeonTools<
	const T extends CreateNeonToolsInput,
	const Inject extends NeonToolInjectOptions | undefined = undefined,
>(
	options: T & { inject?: Inject } & (
			| { name: (id: string) => string; names?: NeonToolNameOverrides }
			| { names: NeonToolNameOverrides; name?: (id: string) => string }
		),
): NamedNeonToolsFor<T, Inject>;
export function createNeonTools<
	const T extends CreateNeonToolsInput,
	const Inject extends NeonToolInjectOptions | undefined = undefined,
>(options: T & { inject?: Inject }): NeonToolsFor<T, Inject>;
export function createNeonTools<
	const T extends CreateNeonToolsInput,
	const Inject extends NeonToolInjectOptions | undefined = undefined,
>(
	options: T & { inject?: Inject },
): NamedNeonToolsFor<T, Inject> | NeonToolsFor<T, Inject> {
	return bindTools(options as BindableToolsInput<T>) as
		| NamedNeonToolsFor<T, Inject>
		| NeonToolsFor<T, Inject>;
}

export function createNeonTool<
	const Id extends NeonToolId,
	const Inject extends NeonToolInjectOptions | undefined = undefined,
	const Throws extends boolean = true,
>(
	id: Id,
	options: NeonToolsClientOptions & {
		inject?: Inject;
		throwOnError?: Throws;
	} & (
			| { name: (id: string) => string; names?: NeonToolNameOverrides }
			| { names: NeonToolNameOverrides; name?: (id: string) => string }
		),
): NamedNeonTool<Id, Inject, Throws>;
export function createNeonTool<
	const Id extends NeonToolId,
	const Inject extends NeonToolInjectOptions | undefined = undefined,
	const Throws extends boolean = true,
>(
	id: Id,
	options: NeonToolsClientOptions & {
		inject?: Inject;
		throwOnError?: Throws;
	},
): WithThrowMode<
	Inject extends NeonToolInjectOptions
		? InjectedNeonTool<ToolForId<Id>, Inject>
		: ToolForId<Id>,
	Throws
>;
export function createNeonTool<
	const Id extends NeonToolId,
	const Inject extends NeonToolInjectOptions | undefined = undefined,
>(
	id: Id,
	options: NeonToolsClientOptions & {
		inject?: Inject;
		name?: (id: string) => string;
		names?: NeonToolNameOverrides;
	},
):
	| NamedNeonTool<Id, Inject, boolean>
	| InjectedNeonTool<ToolForId<Id>, Inject>
	| ToolForId<Id> {
	if (!isNeonToolId(id)) {
		throw unpublishedToolError(id);
	}
	assertToolCustomizeOptions(options);
	const tool = factoryFor(id)(options);
	assertKnownNameKeys(options.names, [tool]);
	const customized = hasToolCustomization(options)
		? applyToolCustomization(tool, options)
		: tool;
	const executed =
		options.throwOnError === false
			? {
					...customized,
					execute: envelopeExecute(
						customized.execute.bind(customized),
					),
				}
			: customized;
	return executed as
		| NamedNeonTool<Id, Inject, boolean>
		| InjectedNeonTool<ToolForId<Id>, Inject>
		| ToolForId<Id>;
}
