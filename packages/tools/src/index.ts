import { createNeonClient, type NeonConfig, NeonError } from "@neon/sdk";
import {
	missingBearerCredential,
	type NeonBearerCredential,
	requireBearerCredential,
} from "./lib/auth.js";
import {
	applyToolCustomization,
	assertToolCustomizeOptions,
	hasToolCustomization,
	type InjectedNeonTool,
	type NeonToolCustomizeOptions,
	type NeonToolInjectOptions,
	type NeonToolNameOverrides,
} from "./lib/customize.js";
import type { NeonTool } from "./lib/operation.js";
import {
	isNeonWorkflowId,
	type NeonWorkflowId,
	type WorkflowFactories,
	workflowFactoryFor,
	workflowIds,
} from "./lib/workflows.js";
import {
	type NeonOperationId,
	operationFactories,
	operationIds,
} from "./operations.gen.js";

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
	NeonTool,
	NeonToolAnnotations,
	NeonToolExecutionContext,
	NeonToolMetadata,
	NeonToolResult,
} from "./lib/operation.js";
export type { NeonOperationId, NeonWorkflowId };
export { NeonError, operationIds, workflowIds };

type OperationFactories = typeof operationFactories;

export type NeonTools<
	Operations extends readonly NeonOperationId[] = [],
	Workflows extends readonly NeonWorkflowId[] = [],
> = {
	[Operation in Operations[number]]: ReturnType<
		OperationFactories[Operation]
	>;
} & {
	[Workflow in Workflows[number]]: ReturnType<WorkflowFactories[Workflow]>;
};

export type InjectedNeonTools<
	Operations extends readonly NeonOperationId[],
	Inject,
	Workflows extends readonly NeonWorkflowId[] = [],
> = {
	[Operation in Operations[number]]: InjectedNeonTool<
		ReturnType<OperationFactories[Operation]>,
		Inject
	>;
} & {
	[Workflow in Workflows[number]]: InjectedNeonTool<
		ReturnType<WorkflowFactories[Workflow]>,
		Inject
	>;
};

type WithPublishedId<Tool> = Tool extends { id: string }
	? Omit<Tool, "id"> & { id: string }
	: Tool;

export interface NeonToolsClientOptions
	extends Pick<NeonConfig, "baseUrl" | "fetch">,
		Omit<NeonToolCustomizeOptions, "name" | "names"> {
	apiKey?: NeonBearerCredential;
}

export type CreateNeonToolsOptions<
	Operations extends readonly NeonOperationId[] = readonly NeonOperationId[],
	Workflows extends readonly NeonWorkflowId[] = readonly [],
> = NeonToolsClientOptions &
	(
		| { operations: Operations; workflows?: Workflows }
		| { operations?: Operations; workflows: Workflows }
	);

type NeonToolId = NeonOperationId | NeonWorkflowId;

type ToolForId<Id extends NeonToolId> = Id extends NeonWorkflowId
	? ReturnType<WorkflowFactories[Id]>
	: Id extends NeonOperationId
		? ReturnType<OperationFactories[Id]>
		: never;

const createRawClient = (options: NeonToolsClientOptions) =>
	createNeonClient({
		apiKey:
			options.apiKey === undefined
				? missingBearerCredential
				: requireBearerCredential(options.apiKey),
		...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	}).client;

const operationFactoryFor = (operationId: NeonOperationId) => {
	const knownOperationId = operationIds.find(
		(candidate) => candidate === operationId,
	);
	if (knownOperationId === undefined) {
		throw new TypeError(`Unknown Neon operation "${operationId}".`);
	}
	return operationFactories[knownOperationId];
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

function assertNeonTools<
	Operations extends readonly NeonOperationId[],
	Workflows extends readonly NeonWorkflowId[],
>(
	value: unknown,
	operations: Operations,
	workflows: Workflows,
): asserts value is NeonTools<Operations, Workflows> {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("Expected generated Neon tools to be an object.");
	}
	for (const operationId of operations) {
		if (!(operationId in value)) {
			throw new TypeError(
				`Missing generated Neon tool "${operationId}".`,
			);
		}
	}
	for (const workflowId of workflows) {
		if (!(workflowId in value)) {
			throw new TypeError(`Missing Neon workflow tool "${workflowId}".`);
		}
	}
}

const bindTools = <
	Operations extends readonly NeonOperationId[],
	Workflows extends readonly NeonWorkflowId[],
>(
	options: CreateNeonToolsOptions<Operations, Workflows> & {
		name?: (id: string) => string;
		names?: NeonToolNameOverrides;
	},
): NeonTools<Operations, Workflows> => {
	assertToolCustomizeOptions(options);
	const operations = options.operations ?? [];
	const workflows = options.workflows ?? [];
	if (operations.length === 0 && workflows.length === 0) {
		throw new TypeError("createNeonTools requires operations or workflows");
	}

	const selectedOperations = new Set<NeonOperationId>();
	const operationEntries = operations.map((operationId) => {
		if (selectedOperations.has(operationId)) {
			throw new Error(`Duplicate Neon operation "${operationId}"`);
		}
		selectedOperations.add(operationId);
		return [
			operationId,
			operationFactoryFor(operationId)(createRawClient(options)),
		] as const;
	});

	const selectedWorkflows = new Set<NeonWorkflowId>();
	const workflowEntries = workflows.map((workflowId) => {
		if (selectedWorkflows.has(workflowId)) {
			throw new Error(`Duplicate Neon workflow "${workflowId}"`);
		}
		selectedWorkflows.add(workflowId);
		return [workflowId, workflowFactoryFor(workflowId)(options)] as const;
	});

	const rawEntries = [...operationEntries, ...workflowEntries];
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
	assertNeonTools(tools, operations, workflows);
	return tools as NeonTools<Operations, Workflows>;
};

type NamedNeonTools<
	Operations extends readonly NeonOperationId[],
	Workflows extends readonly NeonWorkflowId[],
	Inject,
> = {
	[Operation in Operations[number]]: WithPublishedId<
		Inject extends NeonToolInjectOptions
			? InjectedNeonTool<
					ReturnType<OperationFactories[Operation]>,
					Inject
				>
			: ReturnType<OperationFactories[Operation]>
	>;
} & {
	[Workflow in Workflows[number]]: WithPublishedId<
		Inject extends NeonToolInjectOptions
			? InjectedNeonTool<ReturnType<WorkflowFactories[Workflow]>, Inject>
			: ReturnType<WorkflowFactories[Workflow]>
	>;
};

type NamedNeonTool<Id extends NeonToolId, Inject> = WithPublishedId<
	Inject extends NeonToolInjectOptions
		? InjectedNeonTool<ToolForId<Id>, Inject>
		: ToolForId<Id>
>;

export function createNeonTools<
	const Operations extends readonly NeonOperationId[] = [],
	const Workflows extends readonly NeonWorkflowId[] = [],
	const Inject extends NeonToolInjectOptions | undefined = undefined,
>(
	options: CreateNeonToolsOptions<Operations, Workflows> & {
		inject?: Inject;
	} & (
			| { name: (id: string) => string; names?: NeonToolNameOverrides }
			| { names: NeonToolNameOverrides; name?: (id: string) => string }
		),
): NamedNeonTools<Operations, Workflows, Inject>;
export function createNeonTools<
	const Operations extends readonly NeonOperationId[] = [],
	const Workflows extends readonly NeonWorkflowId[] = [],
	const Inject extends NeonToolInjectOptions | undefined = undefined,
>(
	options: CreateNeonToolsOptions<Operations, Workflows> & {
		inject?: Inject;
	},
): Inject extends NeonToolInjectOptions
	? InjectedNeonTools<Operations, Inject, Workflows>
	: NeonTools<Operations, Workflows>;
export function createNeonTools<
	const Operations extends readonly NeonOperationId[] = [],
	const Workflows extends readonly NeonWorkflowId[] = [],
	const Inject extends NeonToolInjectOptions | undefined = undefined,
>(
	options: CreateNeonToolsOptions<Operations, Workflows> & {
		inject?: Inject;
	},
):
	| NamedNeonTools<Operations, Workflows, Inject>
	| InjectedNeonTools<Operations, Inject, Workflows>
	| NeonTools<Operations, Workflows> {
	return bindTools(options) as
		| NamedNeonTools<Operations, Workflows, Inject>
		| InjectedNeonTools<Operations, Inject, Workflows>
		| NeonTools<Operations, Workflows>;
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
	assertToolCustomizeOptions(options);
	let tool: NeonTool;
	if (isNeonWorkflowId(id)) {
		tool = workflowFactoryFor(id)(options);
	} else {
		const knownOperationId = operationIds.find(
			(candidate) => candidate === id,
		);
		if (knownOperationId === undefined) {
			throw new TypeError(`Unknown Neon operation or workflow "${id}".`);
		}
		tool = operationFactories[knownOperationId](createRawClient(options));
	}
	assertKnownNameKeys(options.names, [tool]);
	const customized = hasToolCustomization(options)
		? applyToolCustomization(tool, options)
		: tool;
	return customized as
		| NamedNeonTool<Id, Inject>
		| InjectedNeonTool<ToolForId<Id>, Inject>
		| ToolForId<Id>;
}
