import type * as z from "zod";
import {
	type NeonAdapterNameOptions,
	namedNeonTools,
} from "./lib/adapter-name.js";
import type {
	NeonTool,
	NeonToolExecutionContext,
	NeonToolResult,
} from "./lib/operation.js";

export type { NeonAdapterNameOptions } from "./lib/adapter-name.js";

export interface MastraToolContext {
	abortSignal?: AbortSignal;
}

export type MastraToolConfig<Tool extends NeonTool> = {
	id: Tool["id"];
	description: string;
	inputSchema: Tool["inputSchema"];
	requireApproval: boolean;
	execute(
		input: Parameters<Tool["execute"]>[0],
		context: MastraToolContext,
	): ReturnType<Tool["execute"]>;
};

export type MastraTools<Tools extends Readonly<Record<string, NeonTool>>> = {
	[Tool in Tools[keyof Tools] as Tool["id"]]: MastraToolConfig<Tool>;
};

export type NamedMastraToolConfig<Tool extends NeonTool> = Omit<
	MastraToolConfig<Tool>,
	"id"
> & { id: string };

export type NamedMastraTools<Tools extends Readonly<Record<string, NeonTool>>> =
	Record<string, NamedMastraToolConfig<Tools[keyof Tools]>>;

type MastraToolSource = {
	id: string;
	description: string;
	inputSchema: z.ZodType;
	requiresApproval: boolean;
	execute: (
		input: never,
		context?: NeonToolExecutionContext,
	) => Promise<NeonToolResult<unknown>>;
};

export const toMastraTool = <const Tool extends MastraToolSource>(
	tool: Tool,
) => ({
	id: tool.id,
	description: tool.description,
	inputSchema: tool.inputSchema,
	requireApproval: tool.requiresApproval,
	execute: (
		input: Parameters<Tool["execute"]>[0],
		context: MastraToolContext,
	): ReturnType<Tool["execute"]> =>
		tool.execute(input, { signal: context.abortSignal }) as ReturnType<
			Tool["execute"]
		>,
});

function assertMastraTools(
	value: unknown,
	names: readonly string[],
): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("Expected Mastra tools to be an object.");
	}
	for (const name of names) {
		if (!(name in value)) {
			throw new TypeError(`Missing Mastra tool "${name}".`);
		}
	}
}

export function toMastraTools<
	const Tools extends Readonly<Record<string, NeonTool>>,
>(tools: Tools): MastraTools<Tools>;
export function toMastraTools<
	const Tools extends Readonly<Record<string, NeonTool>>,
>(
	tools: Tools,
	options: { name: (tool: NeonTool) => string },
): NamedMastraTools<Tools>;
export function toMastraTools<
	const Tools extends Readonly<Record<string, NeonTool>>,
>(
	tools: Tools,
	options?: NeonAdapterNameOptions,
): MastraTools<Tools> | NamedMastraTools<Tools> {
	const named = namedNeonTools(tools, options);
	const adapted: unknown = Object.fromEntries(
		named.map(({ tool, name }) => [
			name,
			{ ...toMastraTool(tool), id: name },
		]),
	);
	assertMastraTools(
		adapted,
		named.map(({ name }) => name),
	);
	if (options?.name === undefined) {
		return adapted as MastraTools<Tools>;
	}
	return adapted as NamedMastraTools<Tools>;
}
