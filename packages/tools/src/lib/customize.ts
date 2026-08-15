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

type OptionalInjectedPath<Path, Keys extends string> = [
	keyof Omit<Path, Keys>,
] extends [never]
	? {
			path?: Omit<Path, Keys> &
				Partial<Pick<Path, Extract<Keys, keyof Path>>>;
		}
	: {
			path: Omit<Path, Keys> &
				Partial<Pick<Path, Extract<Keys, keyof Path>>>;
		};

type ApplyInjectToInput<Input, Inject> = [InjectedPathKey<Inject>] extends [
	never,
]
	? Input
	: Input extends { path: infer Path }
		? Inject extends { omitFromSchema: true }
			? [keyof Omit<Path, InjectedPathKey<Inject>>] extends [never]
				? Omit<Input, "path">
				: Omit<Input, "path"> & {
						path: Omit<Path, InjectedPathKey<Inject>>;
					}
			: Omit<Input, "path"> &
					OptionalInjectedPath<Path, InjectedPathKey<Inject>>
		: Input;

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

const missingInjectMessage = (name: "projectId" | "branchId") =>
	`A ${name} inject value is required`;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const assertToolCustomizeOptions = (
	options: NeonToolCustomizeOptions,
): void => {
	resolveInject(options.inject);
};

export const hasToolCustomization = (
	options: NeonToolCustomizeOptions,
): boolean =>
	options.descriptions !== undefined ||
	options.onExecute !== undefined ||
	resolveInject(options.inject).hasAny;

export const applyToolCustomization = <Tool extends NeonTool>(
	tool: Tool,
	options: NeonToolCustomizeOptions,
): Tool => {
	const inject = resolveInject(options.inject);
	const description = applyDescription(tool, options.descriptions);
	const inputSchema = publishInputSchema(tool.inputSchema, inject);
	const wrapExecute = options.onExecute !== undefined || inject.hasAny;

	if (
		description === tool.description &&
		inputSchema === tool.inputSchema &&
		!wrapExecute
	) {
		return tool;
	}

	return {
		...tool,
		description,
		inputSchema,
		execute: wrapExecute
			? wrapToolExecute(tool, options.onExecute, inject)
			: tool.execute,
	};
};

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
	const availableKeys = pathKeys(tool.inputSchema);
	const mode = inject.omitFromSchema ? "override" : "fill";

	return async (input, context) => {
		const run = async () =>
			originalExecute(
				mergePathPatch(
					input,
					await resolveInjectedPath(
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

async function resolveInjectedPath(
	input: unknown,
	inject: ResolvedInject,
	availableKeys: ReadonlySet<string>,
	mode: "fill" | "override",
): Promise<Record<string, string>> {
	const present =
		isPlainObject(input) && isPlainObject(input.path)
			? input.path
			: undefined;
	const patch: Record<string, string> = {};

	for (const [name, pathKey] of [
		["projectId", "project_id"],
		["branchId", "branch_id"],
	] as const) {
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

function mergePathPatch(
	input: unknown,
	patch: Record<string, string>,
	mode: "fill" | "override",
): unknown {
	if (Object.keys(patch).length === 0) {
		return input === undefined ? {} : input;
	}
	if (input === undefined) {
		return { path: patch };
	}
	if (!isPlainObject(input)) {
		return input;
	}

	const path = input.path;
	if (path === undefined) {
		return { ...input, path: patch };
	}
	if (!isPlainObject(path)) {
		return input;
	}

	const nextPath = { ...path };
	for (const [key, value] of Object.entries(patch)) {
		if (mode === "override" || nextPath[key] === undefined) {
			nextPath[key] = value;
		}
	}
	return { ...input, path: nextPath };
}

function cloneInput(input: unknown): unknown {
	if (!isPlainObject(input)) {
		return input;
	}
	if (!isPlainObject(input.path)) {
		return { ...input };
	}
	return { ...input, path: { ...input.path } };
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

function pathKeys(schema: z.ZodType): Set<string> {
	const shape = objectShape(schema);
	if (shape?.path === undefined) {
		return new Set();
	}
	const pathShape = objectShape(shape.path);
	if (pathShape === undefined) {
		return new Set();
	}
	return new Set(Object.keys(pathShape));
}

function publishInputSchema(
	schema: z.ZodType,
	inject: ResolvedInject,
): z.ZodType {
	if (!inject.hasAny) {
		return schema;
	}

	const available = pathKeys(schema);
	const modes: Partial<
		Record<"project_id" | "branch_id", "omit" | "optional">
	> = {};
	if (inject.projectId !== undefined && available.has("project_id")) {
		modes.project_id = inject.omitFromSchema ? "omit" : "optional";
	}
	if (inject.branchId !== undefined && available.has("branch_id")) {
		modes.branch_id = inject.omitFromSchema ? "omit" : "optional";
	}
	if (modes.project_id === undefined && modes.branch_id === undefined) {
		return schema;
	}

	return rewritePathSchema(schema, modes);
}

function rewritePathSchema(
	schema: z.ZodType,
	modes: Partial<Record<"project_id" | "branch_id", "omit" | "optional">>,
): z.ZodType {
	if (!(schema instanceof z.ZodObject)) {
		return schema;
	}

	const shape = schema.shape as Record<string, z.ZodType>;
	if (shape.path === undefined) {
		return schema;
	}

	let pathSchema: unknown = shape.path;
	if (shape.path instanceof z.ZodOptional) {
		pathSchema = shape.path.unwrap();
	}
	const pathWasOptional = shape.path instanceof z.ZodOptional;
	if (!(pathSchema instanceof z.ZodObject)) {
		return schema;
	}

	const pathShape: Record<string, z.ZodType> = { ...pathSchema.shape };
	let changed = false;
	for (const key of ["project_id", "branch_id"] as const) {
		const mode = modes[key];
		if (mode === undefined || pathShape[key] === undefined) {
			continue;
		}
		changed = true;
		if (mode === "omit") {
			delete pathShape[key];
		} else {
			pathShape[key] = pathShape[key].optional();
		}
	}
	if (!changed) {
		return schema;
	}

	const restShape: Record<string, z.ZodType> = { ...shape };
	const remaining = Object.keys(pathShape);
	if (remaining.length === 0) {
		delete restShape.path;
		return Object.keys(restShape).length === 0
			? z.strictObject({})
			: z.strictObject(restShape);
	}

	const nextPath = z.strictObject(pathShape);
	const pathOptional =
		pathWasOptional ||
		remaining.every((key) => pathShape[key] instanceof z.ZodOptional);
	restShape.path = pathOptional ? nextPath.optional() : nextPath;
	return z.strictObject(restShape);
}
