import { createNeonClient, type NeonConfig, NeonError } from "@neon/sdk";
import type { NeonTool } from "./lib/operation.js";
import {
	type NeonOperationId,
	operationFactories,
	operationIds,
} from "./operations.gen.js";

export type {
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

export interface NeonToolsClientOptions
	extends Pick<NeonConfig, "apiKey" | "baseUrl" | "fetch"> {}

export interface CreateNeonToolsOptions<
	Operations extends readonly NeonOperationId[],
> extends NeonToolsClientOptions {
	operations: Operations;
}

const createRawClient = (options: NeonToolsClientOptions) =>
	createNeonClient({
		apiKey: options.apiKey,
		...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	}).client;

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

export const createNeonTools = <
	const Operations extends readonly NeonOperationId[],
>(
	options: CreateNeonToolsOptions<Operations>,
): NeonTools<Operations> => {
	const selected = new Set<NeonOperationId>();
	const client = createRawClient(options);
	const entries = options.operations.map((operationId) => {
		if (selected.has(operationId)) {
			throw new Error(`Duplicate Neon operation "${operationId}"`);
		}
		selected.add(operationId);
		return [operationId, operationFactories[operationId](client)] as const;
	});
	const tools: unknown = Object.fromEntries(entries);
	assertNeonTools(tools, options.operations);
	return tools;
};

export function createNeonTool<const Operation extends NeonOperationId>(
	operationId: Operation,
	options: NeonToolsClientOptions,
): ReturnType<OperationFactories[Operation]>;
export function createNeonTool(
	operationId: NeonOperationId,
	options: NeonToolsClientOptions,
): NeonTool {
	return operationFactories[operationId](createRawClient(options));
}
