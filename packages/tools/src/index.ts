import { NeonError } from "@neon/sdk";
import { inspectChecks } from "./lib/custom/sql/inspect/catalog.js";
import { InspectDiagnosticError } from "./lib/custom/sql/inspect/inspect.js";
import {
	applyToolCustomization,
	assertToolCustomizeOptions,
	type InjectedNeonTool,
	type NeonToolCustomizeOptions,
	type NeonToolInjectOptions,
	type NeonToolNameOverrides,
	publishedToolId,
} from "./lib/customize.js";
import {
	customToolIds,
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
import {
	applyToolPolicy,
	type NeonToolPolicyOptions,
	type NeonToolPredicate,
	toolDescriptor,
} from "./lib/policy.js";

export type { NeonBearerCredential } from "./lib/auth.js";
export type { InspectCheckInfo } from "./lib/custom/sql/inspect/catalog.js";
export type { InspectCheck } from "./lib/custom/sql/inspect/queries.js";
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
	NeonOperationMetadata,
	NeonTool,
	NeonToolAnnotations,
	NeonToolCaller,
	NeonToolExecutionContext,
	NeonToolMetadata,
	NeonToolResult,
} from "./lib/operation.js";
export type {
	NeonToolDescriptor,
	NeonToolPolicyOptions,
	NeonToolPredicate,
} from "./lib/policy.js";
export type { NeonToolId, PublishedId };
export {
	customToolIds,
	InspectDiagnosticError,
	inspectChecks,
	NeonError,
	publishedId,
	toolIds,
};

type ToolFactories = typeof toolFactories;

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
		NeonToolPolicyOptions,
		Omit<NeonToolCustomizeOptions, "name" | "names"> {}

type CreateNeonToolsInput = NeonToolsClientOptions & {
	tools: readonly NeonToolId[] | NeonToolPredicate;
};

type AllNeonToolIds = typeof toolIds;

export type CreateNeonToolsOptions<
	Tools extends readonly NeonToolId[] = readonly NeonToolId[],
> = NeonToolsClientOptions & { tools: Tools };

type SelectedTools<T> = T extends {
	tools: infer S extends readonly NeonToolId[];
}
	? S
	: [];

type NeonToolsFor<T, Inject> = T extends CreateNeonToolsInput
	? T extends { tools: NeonToolPredicate }
		? Partial<
				Inject extends NeonToolInjectOptions
					? InjectedNeonTools<AllNeonToolIds, Inject>
					: NeonTools<AllNeonToolIds>
			>
		: Inject extends NeonToolInjectOptions
			? InjectedNeonTools<SelectedTools<T>, Inject>
			: NeonTools<SelectedTools<T>>
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

const publishedIdOf = (
	publishedIds: ReadonlyMap<string, string>,
	toolId: NeonToolId,
): string => {
	const published = publishedIds.get(toolId);
	if (published === undefined) {
		throw new TypeError(`No published id for ${toolId}`);
	}
	return published;
};

const selectedEntries = (
	options: CreateNeonToolsInput,
): Array<readonly [NeonToolId, ReturnType<ToolFactory>]> => {
	const selection = options.tools;
	if (typeof selection === "function") {
		const entries = toolIds
			.map((toolId) => [toolId, factoryFor(toolId)(options)] as const)
			.filter(([, tool]) => selection(toolDescriptor(tool)));
		if (entries.length === 0) {
			throw new TypeError(
				"The createNeonTools tools predicate matched no tool",
			);
		}
		return entries;
	}
	if (selection === undefined || selection.length === 0) {
		throw new TypeError("createNeonTools requires at least one tool");
	}
	const seen = new Set<NeonToolId>();
	return selection.map((toolId) => {
		if (seen.has(toolId)) {
			throw new Error(`Duplicate Neon tool "${toolId}"`);
		}
		seen.add(toolId);
		return [toolId, factoryFor(toolId)(options)] as const;
	});
};

const bindTools = <T extends CreateNeonToolsInput>(
	options: BindableToolsInput<T>,
): NeonTools<SelectedTools<T>> => {
	assertToolCustomizeOptions(options);
	const rawEntries = selectedEntries(options);
	const selected = rawEntries.map(([toolId]) => toolId);

	assertKnownNameKeys(
		options.names,
		rawEntries.map(([, tool]) => tool),
	);
	const publishedIds = new Map<string, string>();
	const selectorsById = new Map<string, string>();
	for (const [id, tool] of rawEntries) {
		const published = publishedToolId(tool, options);
		const previous = selectorsById.get(published);
		if (previous !== undefined) {
			throw new Error(
				`Duplicate Neon tool id "${published}" for ${previous}, ${id}`,
			);
		}
		selectorsById.set(published, id);
		publishedIds.set(id, published);
	}
	const entries = rawEntries.map(
		([id, tool]) =>
			[
				id,
				applyToolCustomization(
					applyToolPolicy(
						tool,
						options,
						publishedIdOf(publishedIds, id),
					),
					options,
					publishedIds,
				),
			] as const,
	);
	const tools: unknown = Object.fromEntries(entries);
	assertNeonTools(tools, selected);
	return tools as NeonTools<SelectedTools<T>>;
};

type NamedNeonTools<Tools extends readonly NeonToolId[], Inject> = {
	[Tool in Tools[number]]: WithPublishedId<
		Inject extends NeonToolInjectOptions
			? InjectedNeonTool<ReturnType<ToolFactories[Tool]>, Inject>
			: ReturnType<ToolFactories[Tool]>
	>;
};

type NamedNeonTool<Id extends NeonToolId, Inject> = WithPublishedId<
	Inject extends NeonToolInjectOptions
		? InjectedNeonTool<ToolForId<Id>, Inject>
		: ToolForId<Id>
>;

type NamedNeonToolsFor<T, Inject> = T extends CreateNeonToolsInput
	? T extends { tools: NeonToolPredicate }
		? Partial<NamedNeonTools<AllNeonToolIds, Inject>>
		: NamedNeonTools<SelectedTools<T>, Inject>
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
>(
	id: Id,
	options: NeonToolsClientOptions & {
		inject?: Inject;
	} & (
			| { name: (id: string) => string; names?: NeonToolNameOverrides }
			| { names: NeonToolNameOverrides; name?: (id: string) => string }
		),
): NamedNeonTool<Id, Inject>;
export function createNeonTool<
	const Id extends NeonToolId,
	const Inject extends NeonToolInjectOptions | undefined = undefined,
>(
	id: Id,
	options: NeonToolsClientOptions & { inject?: Inject },
): Inject extends NeonToolInjectOptions
	? InjectedNeonTool<ToolForId<Id>, Inject>
	: ToolForId<Id>;
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
	| NamedNeonTool<Id, Inject>
	| InjectedNeonTool<ToolForId<Id>, Inject>
	| ToolForId<Id> {
	if (!isNeonToolId(id)) {
		throw unpublishedToolError(id);
	}
	assertToolCustomizeOptions(options);
	const tool = factoryFor(id)(options);
	assertKnownNameKeys(options.names, [tool]);
	const published = publishedToolId(tool, options);
	const publishedIds = new Map([[id, published]]);
	return applyToolCustomization(
		applyToolPolicy(tool, options, published),
		options,
		publishedIds,
	) as
		| NamedNeonTool<Id, Inject>
		| InjectedNeonTool<ToolForId<Id>, Inject>
		| ToolForId<Id>;
}
