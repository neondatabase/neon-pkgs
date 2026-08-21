import { createNeonClient, type NeonClient } from "@neon/sdk";
import * as z from "zod";
import * as zod from "../generated/zod.gen.js";
import {
	missingBearerCredential,
	type NeonBearerCredential,
	requireBearerCredential,
} from "./auth.js";
import type {
	JsonSafe,
	NeonTool,
	NeonToolExecutionContext,
} from "./operation.js";
import { toToolResult } from "./result.js";

export interface WorkflowClientOptions {
	apiKey?: NeonBearerCredential;
	baseUrl?: string;
	fetch?: typeof fetch;
}

const branchCreateFields = zod.zBranchCreateRequest.shape.branch.unwrap().shape;
const projectCreateFields = zod.zCreateProjectBody.shape.project.shape;

const writeAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	openWorldHint: true,
} as const;

const pooledField = z.boolean().optional();

export const createWithComputeInputSchema = z.strictObject({
	project_id: zod.zCreateProjectBranchPath.shape.project_id,
	name: branchCreateFields.name,
	parent_id: branchCreateFields.parent_id,
	compute: z
		.strictObject({
			min_cu: zod.zComputeUnit.optional(),
			max_cu: zod.zComputeUnit.optional(),
			suspend_timeout_seconds: zod.zSuspendTimeoutSeconds.optional(),
		})
		.optional(),
	pooled: pooledField,
});

export const createAndConnectInputSchema = z.strictObject({
	...projectCreateFields,
	pooled: pooledField,
});

export const workflowIds = ["createWithCompute", "createAndConnect"] as const;

export type NeonWorkflowId = (typeof workflowIds)[number];

const resolveApiKey = (
	options: WorkflowClientOptions,
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

const workflowClient = (
	options: WorkflowClientOptions,
	context?: NeonToolExecutionContext,
): NeonClient<true> =>
	createNeonClient({
		apiKey: resolveApiKey(options, context),
		throwOnError: true,
		...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	});

const bindWorkflow = <
	const InputSchema extends z.ZodType,
	const Id extends string,
	Output,
>(
	options: WorkflowClientOptions,
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
			workflowClient(options, context),
			parsed,
			context?.signal,
		);
		return toToolResult(result);
	},
});

const createWithComputeTool = (options: WorkflowClientOptions) =>
	bindWorkflow(
		options,
		{
			operationId: "createWithCompute",
			id: "create_with_compute",
			title: "Create branch with compute",
			description:
				"Create a branch with a read-write endpoint and return a ready-to-use connection string. One API call (Neon creates the endpoint inline) plus readiness polling.",
			inputSchema: createWithComputeInputSchema,
			annotations: writeAnnotations,
			requiresApproval: true,
			metadata: {
				method: "POST",
				path: "/projects/{project_id}/branches",
				stability: "stable",
				deprecated: false,
				tags: ["Branch"],
			},
		},
		(neon, input, signal) =>
			neon.branches.createWithCompute(
				input.project_id,
				{
					name: input.name,
					parentId: input.parent_id,
					compute:
						input.compute === undefined
							? undefined
							: {
									minCu: input.compute.min_cu,
									maxCu: input.compute.max_cu,
									suspendTimeoutSeconds:
										input.compute.suspend_timeout_seconds,
								},
				},
				{
					signal,
					...(input.pooled === undefined
						? {}
						: { pooled: input.pooled }),
				},
			),
	);

const createAndConnectTool = (options: WorkflowClientOptions) =>
	bindWorkflow(
		options,
		{
			operationId: "createAndConnect",
			id: "create_and_connect",
			title: "Create project and connect",
			description:
				"Create a project and return a ready-to-use connection string to its default branch. One API call plus readiness polling.",
			inputSchema: createAndConnectInputSchema,
			annotations: writeAnnotations,
			requiresApproval: true,
			metadata: {
				method: "POST",
				path: "/projects",
				stability: "stable",
				deprecated: false,
				tags: ["Project"],
			},
		},
		(neon, input, signal) => {
			const { pooled, ...project } = input;
			return neon.projects.createAndConnect(project, {
				signal,
				...(pooled === undefined ? {} : { pooled }),
			});
		},
	);

export const workflowFactories = {
	createWithCompute: createWithComputeTool,
	createAndConnect: createAndConnectTool,
};

export type WorkflowFactories = typeof workflowFactories;

export const isNeonWorkflowId = (id: string): id is NeonWorkflowId =>
	(workflowIds as readonly string[]).includes(id);

export const workflowFactoryFor = (
	workflowId: NeonWorkflowId,
): WorkflowFactories[NeonWorkflowId] => {
	const knownWorkflowId = workflowIds.find(
		(candidate) => candidate === workflowId,
	);
	if (knownWorkflowId === undefined) {
		throw new TypeError(`Unknown Neon workflow "${workflowId}".`);
	}
	return workflowFactories[knownWorkflowId];
};
