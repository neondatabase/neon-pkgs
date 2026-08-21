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
} from "./lib/customize.js";
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
export type { NeonOperationId };
export { NeonError, operationIds };

type OperationFactories = typeof operationFactories;

export type NeonTools<Operations extends readonly NeonOperationId[]> = {
	[Operation in Operations[number]]: ReturnType<
		OperationFactories[Operation]
	>;
};

export type InjectedNeonTools<
	Operations extends readonly NeonOperationId[],
	Inject,
> = {
	[Operation in Operations[number]]: InjectedNeonTool<
		ReturnType<OperationFactories[Operation]>,
		Inject
	>;
};

export interface NeonToolsClientOptions
	extends Pick<NeonConfig, "baseUrl" | "fetch">,
		NeonToolCustomizeOptions {
	apiKey?: NeonBearerCredential;
}

export interface CreateNeonToolsOptions<
	Operations extends readonly NeonOperationId[],
> extends NeonToolsClientOptions {
	operations: Operations;
}

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

function assertNeonTools<Operations extends readonly NeonOperationId[]>(
	value: unknown,
	operations: Operations,
): asserts value is NeonTools<Operations> {
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
}

const bindTools = <Operations extends readonly NeonOperationId[]>(
	options: CreateNeonToolsOptions<Operations>,
): NeonTools<Operations> => {
	assertToolCustomizeOptions(options);
	const selected = new Set<NeonOperationId>();
	const selectedFactories = options.operations.map((operationId) => {
		if (selected.has(operationId)) {
			throw new Error(`Duplicate Neon operation "${operationId}"`);
		}
		selected.add(operationId);
		return [operationId, operationFactoryFor(operationId)] as const;
	});
	const client = createRawClient(options);
	const entries = selectedFactories.map(([operationId, factory]) => {
		const tool = factory(client);
		return [
			operationId,
			hasToolCustomization(options)
				? applyToolCustomization(tool, options)
				: tool,
		] as const;
	});
	const publishedIds = new Set<string>();
	for (const [, tool] of entries) {
		if (publishedIds.has(tool.id)) {
			throw new Error(`Duplicate Neon tool id "${tool.id}"`);
		}
		publishedIds.add(tool.id);
	}
	const tools: unknown = Object.fromEntries(entries);
	assertNeonTools(tools, options.operations);
	return tools;
};

export const createNeonTools = <
	const Operations extends readonly NeonOperationId[],
	const Inject extends NeonToolInjectOptions | undefined = undefined,
>(
	options: CreateNeonToolsOptions<Operations> & { inject?: Inject },
): Inject extends NeonToolInjectOptions
	? InjectedNeonTools<Operations, Inject>
	: NeonTools<Operations> =>
	bindTools(options) as Inject extends NeonToolInjectOptions
		? InjectedNeonTools<Operations, Inject>
		: NeonTools<Operations>;

export function createNeonTool<
	const Operation extends NeonOperationId,
	const Inject extends NeonToolInjectOptions | undefined = undefined,
>(
	operationId: Operation,
	options: NeonToolsClientOptions & { inject?: Inject },
): Inject extends NeonToolInjectOptions
	? InjectedNeonTool<ReturnType<OperationFactories[Operation]>, Inject>
	: ReturnType<OperationFactories[Operation]> {
	assertToolCustomizeOptions(options);
	const tool = operationFactoryFor(operationId)(createRawClient(options));
	const customized = hasToolCustomization(options)
		? applyToolCustomization(tool, options)
		: tool;
	return customized as Inject extends NeonToolInjectOptions
		? InjectedNeonTool<ReturnType<OperationFactories[Operation]>, Inject>
		: ReturnType<OperationFactories[Operation]>;
}
