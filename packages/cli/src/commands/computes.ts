import type { Endpoint, EndpointUpdateRequest } from "@neon/sdk";
import type yargs from "yargs";
import { log } from "../log.js";
import { endpointUpdateRequest } from "../parameters.gen.js";
import type { BranchScopeProps, ProjectScopeProps } from "../types.js";
import { getComputeUnits } from "../utils/compute_units.js";
import {
	fillSingleProject,
	resolveBranchFromProps,
} from "../utils/enrichers.js";
import { writer } from "../writer.js";

const COMPUTE_FIELDS = [
	"id",
	"branch_id",
	"type",
	"current_state",
	"autoscaling_limit_min_cu",
	"autoscaling_limit_max_cu",
] as const satisfies readonly (keyof Endpoint)[];

const COMPUTE_DETAIL_FIELDS = [
	"id",
	"name",
	"branch_id",
	"type",
	"current_state",
	"pending_state",
	"host",
	"region_id",
	"autoscaling_limit_min_cu",
	"autoscaling_limit_max_cu",
	"suspend_timeout_seconds",
	"disabled",
	"last_active",
	"created_at",
] as const satisfies readonly (keyof Endpoint)[];

const waitOption = {
	wait: {
		describe:
			"Wait until the change is applied. Use --no-wait to return as soon as the API accepts it",
		type: "boolean",
		default: true,
	},
} as const;

type ComputeProps = ProjectScopeProps & { id: string };
type WaitProps = ComputeProps & { wait: boolean };
type UpdateProps = WaitProps & {
	cu?: string;
	suspendTimeout?: number;
	name?: string;
	disabled?: boolean;
};

export const command = "computes";
export const aliases = ["compute", "endpoints", "endpoint"];
export const describe = "Manage Postgres computes";
export const builderFor = (usage: string) => (argv: yargs.Argv) =>
	argv
		.usage(`$0 ${usage} <sub-command> [options]`)
		.options({
			"project-id": {
				describe: "Project ID",
				type: "string",
			},
		})
		.middleware(fillSingleProject as any)
		.command(
			"list",
			"List computes. Lists the branch's computes when --branch is passed or .neon pins one, otherwise every compute in the project",
			(yargs) =>
				yargs.options({
					branch: {
						describe: "Branch ID or name",
						type: "string",
					},
					"all-branches": {
						describe:
							"List every compute in the project, ignoring --branch and the branch .neon pins",
						type: "boolean",
						default: false,
					},
				}),
			(args) => list(args as any),
		)
		.command(
			"get <id>",
			"Get a compute",
			(yargs) => yargs,
			(args) => get(args as any),
		)
		.command(
			"update <id>",
			"Update a compute's size, scale-to-zero timeout, name, or connection access",
			(yargs) =>
				yargs.options({
					cu: {
						describe:
							'The number of Compute Units. Could be a fixed size (e.g. "2") or a range delimited by a dash (e.g. "0.5-3").',
						type: "string",
					},
					"suspend-timeout": {
						describe:
							endpointUpdateRequest[
								"endpoint.suspend_timeout_seconds"
							].description,
						type: "number",
					},
					name: {
						describe: "Name of the compute",
						type: "string",
					},
					disabled: {
						describe:
							"Restrict connections to the compute. Disabling schedules a suspend. Use --disabled=false to allow connections again.",
						type: "boolean",
					},
					...waitOption,
				}),
			(args) => update(args as any),
		)
		.command(
			"start <id>",
			"Start a compute",
			(yargs) => yargs.options(waitOption),
			(args) => start(args as any),
		)
		.command(
			"suspend <id>",
			"Suspend a compute",
			(yargs) => yargs.options(waitOption),
			(args) => suspend(args as any),
		)
		.command(
			"restart <id>",
			"Restart a compute",
			(yargs) => yargs.options(waitOption),
			(args) => restart(args as any),
		)
		.command(
			"delete <id>",
			"Delete a compute",
			(yargs) => yargs.options(waitOption),
			(args) => deleteCompute(args as any),
		);

export const builder = builderFor("computes");

export const handler = (args: yargs.Argv) => {
	return args;
};

const sdk = async (props: ProjectScopeProps) => {
	const { fromSdkError, getNeonClient } = await import("../neon_client.js");
	return {
		neon: getNeonClient(props),
		fail: (error: unknown) => fromSdkError(error, props.apiHost),
	};
};

const writeCompute = (
	props: ProjectScopeProps,
	compute: Endpoint,
	humanTitle?: string,
) => {
	writer(props).end(compute, {
		fields: COMPUTE_DETAIL_FIELDS,
		humanTitle,
	});
};

export const list = async (
	props: ProjectScopeProps & { branch?: string; allBranches: boolean },
) => {
	const { neon, fail } = await sdk(props);
	if (props.allBranches || props.branch === undefined) {
		const computes = await neon.postgres.endpoints
			.list({ projectId: props.projectId })
			.catch((error: unknown) => {
				throw fail(error);
			});
		writer(props).end(computes, {
			fields: COMPUTE_FIELDS,
			humanTitle: `Computes in project ${props.projectId}`,
			emptyMessage: `No computes in project ${props.projectId}.`,
		});
		return;
	}
	const { branchId, branch } = await resolveBranchFromProps(
		props as BranchScopeProps,
	);
	const computes = await neon.postgres.endpoints
		.listByBranch({ projectId: props.projectId, branchId })
		.catch((error: unknown) => {
			throw fail(error);
		});
	const branchLabel = branch?.name ?? branchId;
	writer(props).end(computes, {
		fields: COMPUTE_FIELDS,
		humanTitle: `Computes on ${branchLabel}`,
		emptyMessage: `No computes on ${branchLabel}.`,
	});
};

export const get = async (props: ComputeProps) => {
	const { neon, fail } = await sdk(props);
	const compute = await neon.postgres.endpoints
		.get({ projectId: props.projectId, endpointId: props.id })
		.catch((error: unknown) => {
			throw fail(error);
		});
	writeCompute(props, compute);
};

const updateRequest = (
	props: Pick<UpdateProps, "cu" | "suspendTimeout" | "name" | "disabled">,
): EndpointUpdateRequest["endpoint"] => {
	const endpoint: EndpointUpdateRequest["endpoint"] = {
		...(props.cu === undefined ? {} : getComputeUnits(props.cu)),
		...(props.suspendTimeout === undefined
			? {}
			: { suspend_timeout_seconds: props.suspendTimeout }),
		...(props.name === undefined ? {} : { name: props.name }),
		...(props.disabled === undefined ? {} : { disabled: props.disabled }),
	};
	if (Object.keys(endpoint).length === 0) {
		throw new Error(
			"Nothing to update. Pass --cu, --suspend-timeout, --name, or --disabled.",
		);
	}
	return endpoint;
};

/**
 * Mutations return the compute as it was when the request was accepted, so after waiting
 * the compute is read again to show the state the change produced.
 */
const mutate = async (
	props: WaitProps,
	action: { verb: string; done: string },
	run: (
		neon: Awaited<ReturnType<typeof sdk>>["neon"],
		params: { projectId: string; endpointId: string },
		opts: { waitForReadiness: boolean },
	) => Promise<Endpoint>,
) => {
	const { neon, fail } = await sdk(props);
	const params = { projectId: props.projectId, endpointId: props.id };
	try {
		const accepted = await run(neon, params, {
			waitForReadiness: props.wait,
		});
		if (!props.wait) {
			writeCompute(
				props,
				accepted,
				`Compute ${props.id}: ${action.verb} accepted, not yet applied`,
			);
			return;
		}
		writeCompute(
			props,
			await neon.postgres.endpoints.get(params),
			`Compute ${props.id} ${action.done}`,
		);
	} catch (error) {
		throw fail(error);
	}
};

export const update = (props: UpdateProps) => {
	const endpoint = updateRequest(props);
	return mutate(
		props,
		{ verb: "update", done: "updated" },
		(neon, params, opts) =>
			neon.postgres.endpoints.update({ ...params, ...endpoint }, opts),
	);
};

export const start = (props: WaitProps) =>
	mutate(props, { verb: "start", done: "started" }, (neon, params, opts) =>
		neon.postgres.endpoints.start(params, opts),
	);

export const suspend = (props: WaitProps) =>
	mutate(
		props,
		{ verb: "suspend", done: "suspended" },
		(neon, params, opts) => neon.postgres.endpoints.suspend(params, opts),
	);

export const restart = (props: WaitProps) =>
	mutate(
		props,
		{ verb: "restart", done: "restarted" },
		(neon, params, opts) => neon.postgres.endpoints.restart(params, opts),
	);

export const deleteCompute = async (props: WaitProps) => {
	const { neon, fail } = await sdk(props);
	await neon.postgres.endpoints
		.delete(
			{ projectId: props.projectId, endpointId: props.id },
			{ waitForReadiness: props.wait },
		)
		.catch((error: unknown) => {
			throw fail(error);
		});
	log.info(
		props.wait
			? `Compute ${props.id} deleted`
			: `Compute ${props.id}: delete accepted, not yet applied`,
	);
};
