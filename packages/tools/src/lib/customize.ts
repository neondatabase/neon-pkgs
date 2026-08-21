import * as z from "zod";
import type {
	NeonTool,
	NeonToolExecutionContext,
	NeonToolResult,
} from "./operation.js";

export type NeonToolInjectValue =
	| string
	| (() => string | undefined | Promise<string | undefined>);

export interface NeonToolInjectOptions {
	projectId?: NeonToolInjectValue;
	branchId?: NeonToolInjectValue;
	omitFromSchema?: boolean;
}

export interface NeonToolDescriptionSource {
	operationId: string;
	id: string;
	title: string;
	description: string;
}

export type NeonToolDescriptionOverrides =
	| Readonly<Record<string, string>>
	| ((tool: NeonToolDescriptionSource) => string);

export type NeonToolNameSource = Pick<
	NeonToolDescriptionSource,
	"operationId" | "id"
>;

export type NeonToolNameOverrides =
	| Readonly<Record<string, string>>
	| ((tool: NeonToolNameSource) => string);

export interface NeonToolOnExecuteEvent<Output = unknown> {
	operationId: string;
	id: string;
	input: unknown;
	execute: () => Promise<NeonToolResult<Output>>;
}

export type NeonToolOnExecute = <Output>(
	event: NeonToolOnExecuteEvent<Output>,
) => Promise<NeonToolResult<Output>>;

export interface NeonToolCustomizeOptions {
	descriptions?: NeonToolDescriptionOverrides;
	names?: NeonToolNameOverrides;
	name?: (id: string) => string;
	onExecute?: NeonToolOnExecute;
	inject?: NeonToolInjectOptions;
}

type InjectedPathKey<Inject> =
	| ("projectId" extends keyof Inject
			? Inject["projectId"] extends undefined
				? never
				: "project_id"
			: never)
	| ("branchId" extends keyof Inject
			? Inject["branchId"] extends undefined
				? never
				: "branch_id"
			: never);

type RequiredKeys<Input> = {
	[Key in keyof Input]-?: object extends Pick<Input, Key> ? never : Key;
}[keyof Input];

type InjectedRequiredKey<Input, Inject> = Extract<
	InjectedPathKey<Inject>,
	RequiredKeys<Input>
>;

type ApplyInjectToInput<Input, Inject> = [
	InjectedRequiredKey<Input, Inject>,
] extends [never]
	? Input
	: Inject extends { omitFromSchema: true }
		? Omit<Input, InjectedRequiredKey<Input, Inject>>
		: Omit<Input, InjectedRequiredKey<Input, Inject>> &
				Partial<
					Pick<
						Input,
						Extract<InjectedRequiredKey<Input, Inject>, keyof Input>
					>
				>;

export type InjectedNeonTool<Tool, Inject> =
	Tool extends NeonTool<infer Schema, string, infer Output>
		? Omit<Tool, "execute"> & {
				execute(
					input: ApplyInjectToInput<z.input<Schema>, Inject>,
					context?: NeonToolExecutionContext,
				): Promise<NeonToolResult<Output>>;
			}
		: Tool;

interface ResolvedInject {
	projectId?: NeonToolInjectValue;
	branchId?: NeonToolInjectValue;
	omitFromSchema: boolean;
	hasAny: boolean;
}

const PATH_INJECT = [
	["projectId", "project_id"],
	["branchId", "branch_id"],
] as const;

const PUBLISHED_ID = /^[a-z][a-z0-9_]*$/;

const missingInjectMessage = (name: "projectId" | "branchId") =>
	`A ${name} inject value is required`;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const pathTemplateParams = (path: string): Set<string> =>
	new Set([...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]));

export const assertToolCustomizeOptions = (
	options: NeonToolCustomizeOptions,
): void => {
	resolveInject(options.inject);
	if (options.name !== undefined && typeof options.name !== "function") {
		throw new TypeError("Neon tool name transforms must be functions");
	}
	if (
		options.names !== undefined &&
		typeof options.names !== "function" &&
		(typeof options.names !== "object" ||
			options.names === null ||
			Array.isArray(options.names))
	) {
		throw new TypeError(
			"Neon tool name overrides must be a map or a function",
		);
	}
};

export const hasToolCustomization = (
	options: NeonToolCustomizeOptions,
): boolean =>
	options.descriptions !== undefined ||
	options.names !== undefined ||
	options.name !== undefined ||
	options.onExecute !== undefined ||
	resolveInject(options.inject).hasAny;

export const applyToolCustomization = <Tool extends NeonTool>(
	tool: Tool,
	options: NeonToolCustomizeOptions,
): Omit<Tool, "id"> & { id: string } => {
	const inject = resolveInject(options.inject);
	const id = publishedId(tool, options);
	const description = applyDescription(tool, options.descriptions);
	const inputSchema = publishInputSchema(
		tool.inputSchema,
		inject,
		pathTemplateParams(tool.metadata.path),
	);
	const wrapExecute = options.onExecute !== undefined || inject.hasAny;

	return {
		...tool,
		id,
		description,
		inputSchema,
		execute: wrapExecute
			? wrapToolExecute({ ...tool, id }, options.onExecute, inject)
			: tool.execute,
	};
};

function publishedId(
	tool: NeonTool,
	options: NeonToolCustomizeOptions,
): string {
	let id = tool.id;
	if (options.names !== undefined) {
		if (typeof options.names === "function") {
			id = options.names({
				operationId: tool.operationId,
				id: tool.id,
			});
		} else {
			const override =
				options.names[tool.operationId] ?? options.names[tool.id];
			if (override !== undefined) {
				id = override;
			}
		}
	}
	if (options.name !== undefined) {
		id = options.name(id);
	}
	if (typeof id !== "string" || !PUBLISHED_ID.test(id)) {
		throw new TypeError(
			`Neon tool id must match ${PUBLISHED_ID}: received ${JSON.stringify(id)}`,
		);
	}
	return id;
}

function resolveInject(
	inject: NeonToolInjectOptions | undefined,
): ResolvedInject {
	if (inject === undefined) {
		return { omitFromSchema: false, hasAny: false };
	}

	const projectId = requireInjectValue("projectId", inject.projectId);
	const branchId = requireInjectValue("branchId", inject.branchId);
	const hasAny = projectId !== undefined || branchId !== undefined;
	const omitFromSchema = inject.omitFromSchema === true;
	if (omitFromSchema && !hasAny) {
		throw new TypeError(
			"omitFromSchema requires inject.projectId or inject.branchId",
		);
	}

	return { projectId, branchId, omitFromSchema, hasAny };
}

function requireInjectValue(
	name: "projectId" | "branchId",
	value: NeonToolInjectValue | undefined,
): NeonToolInjectValue | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value === "function") {
		return value;
	}
	if (typeof value === "string") {
		if (value.length === 0) {
			throw new TypeError(missingInjectMessage(name));
		}
		return value;
	}
	throw new TypeError(missingInjectMessage(name));
}

function applyDescription(
	tool: NeonTool,
	descriptions: NeonToolDescriptionOverrides | undefined,
): string {
	if (descriptions === undefined) {
		return tool.description;
	}

	if (typeof descriptions === "function") {
		const description = descriptions({
			operationId: tool.operationId,
			id: tool.id,
			title: tool.title,
			description: tool.description,
		});
		if (typeof description !== "string") {
			throw new TypeError(
				"Neon tool description overrides must return a string",
			);
		}
		return description;
	}

	const description = descriptions[tool.operationId] ?? descriptions[tool.id];
	if (description === undefined) {
		return tool.description;
	}
	if (typeof description !== "string") {
		throw new TypeError("Neon tool description overrides must be strings");
	}
	return description;
}

function wrapToolExecute(
	tool: NeonTool,
	onExecute: NeonToolOnExecute | undefined,
	inject: ResolvedInject,
): NeonTool["execute"] {
	const originalExecute = tool.execute.bind(tool);
	const availableKeys = pathTemplateParams(tool.metadata.path);
	const mode = inject.omitFromSchema ? "override" : "fill";

	return async (input, context) => {
		const run = async () =>
			originalExecute(
				mergeFields(
					input,
					await resolveInjectedFields(
						input,
						inject,
						availableKeys,
						mode,
					),
					mode,
				),
				context,
			);

		if (onExecute === undefined) {
			return run();
		}

		return onExecute({
			operationId: tool.operationId,
			id: tool.id,
			input: cloneInput(input),
			execute: run,
		});
	};
}

async function resolveInjectedFields(
	input: unknown,
	inject: ResolvedInject,
	availableKeys: ReadonlySet<string>,
	mode: "fill" | "override",
): Promise<Record<string, string>> {
	const present = isPlainObject(input) ? input : undefined;
	const patch: Record<string, string> = {};

	for (const [name, pathKey] of PATH_INJECT) {
		if (!availableKeys.has(pathKey)) {
			continue;
		}
		const injector = inject[name];
		if (injector === undefined) {
			continue;
		}
		if (mode === "fill" && present?.[pathKey] !== undefined) {
			continue;
		}

		const value =
			typeof injector === "function" ? await injector() : injector;
		if (value === undefined) {
			if (mode === "override") {
				throw new TypeError(missingInjectMessage(name));
			}
			continue;
		}
		if (typeof value !== "string" || value.length === 0) {
			throw new TypeError(missingInjectMessage(name));
		}
		patch[pathKey] = value;
	}

	return patch;
}

function mergeFields(
	input: unknown,
	patch: Record<string, string>,
	mode: "fill" | "override",
): unknown {
	if (Object.keys(patch).length === 0) {
		return input === undefined ? {} : input;
	}
	if (input === undefined) {
		return patch;
	}
	if (!isPlainObject(input)) {
		return input;
	}

	const next = { ...input };
	for (const [key, value] of Object.entries(patch)) {
		if (mode === "override" || next[key] === undefined) {
			next[key] = value;
		}
	}
	return next;
}

function cloneInput(input: unknown): unknown {
	if (!isPlainObject(input)) {
		return input;
	}
	return { ...input };
}

function objectShape(schema: unknown): Record<string, z.ZodType> | undefined {
	if (schema instanceof z.ZodOptional) {
		return objectShape(schema.unwrap());
	}
	if (schema instanceof z.ZodObject) {
		return schema.shape as Record<string, z.ZodType>;
	}
	return undefined;
}

function publishInputSchema(
	schema: z.ZodType,
	inject: ResolvedInject,
	pathKeys: ReadonlySet<string>,
): z.ZodType {
	if (!inject.hasAny) {
		return schema;
	}

	const shape = objectShape(schema);
	if (shape === undefined) {
		return schema;
	}

	const nextShape: Record<string, z.ZodType> = { ...shape };
	let changed = false;
	for (const [name, pathKey] of PATH_INJECT) {
		if (inject[name] === undefined || !pathKeys.has(pathKey)) {
			continue;
		}
		if (nextShape[pathKey] === undefined) {
			continue;
		}
		changed = true;
		if (inject.omitFromSchema) {
			delete nextShape[pathKey];
		} else {
			nextShape[pathKey] = nextShape[pathKey].optional();
		}
	}
	if (!changed) {
		return schema;
	}

	return Object.keys(nextShape).length === 0
		? z.strictObject({})
		: z.strictObject(nextShape);
}
