import {
	createProjectEndpoint,
	deleteProjectEndpoint,
	getProjectEndpoint,
	listProjectBranchEndpoints,
	listProjectEndpoints,
	restartProjectEndpoint,
	startProjectEndpoint,
	suspendProjectEndpoint,
	updateProjectEndpoint,
} from "../../client/sdk.gen.js";
import type {
	Endpoint,
	EndpointPoolerMode,
	EndpointSettingsData,
	EndpointType,
	Provisioner,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import type { NeonResult, Outcome } from "../result.js";
import type { ComputeSettings } from "./branches.js";

export interface EndpointCreateInput {
	branchId: string;
	type: EndpointType;
	name?: string;
	regionId?: string;
	compute?: ComputeSettings;
	provisioner?: Provisioner;
	settings?: EndpointSettingsData;
	poolerEnabled?: boolean;
	poolerMode?: EndpointPoolerMode;
	disabled?: boolean;
	passwordlessAccess?: boolean;
}

export interface EndpointUpdateInput {
	branchId?: string;
	name?: string;
	compute?: ComputeSettings;
	provisioner?: Provisioner;
	settings?: EndpointSettingsData;
	poolerEnabled?: boolean;
	poolerMode?: EndpointPoolerMode;
	disabled?: boolean;
	passwordlessAccess?: boolean;
}

function mapEndpointCreate(input: EndpointCreateInput) {
	return {
		branch_id: input.branchId,
		type: input.type,
		...(input.name !== undefined ? { name: input.name } : {}),
		...(input.regionId !== undefined ? { region_id: input.regionId } : {}),
		...(input.compute?.minCu !== undefined
			? { autoscaling_limit_min_cu: input.compute.minCu }
			: {}),
		...(input.compute?.maxCu !== undefined
			? { autoscaling_limit_max_cu: input.compute.maxCu }
			: {}),
		...(input.compute?.suspendTimeoutSeconds !== undefined
			? { suspend_timeout_seconds: input.compute.suspendTimeoutSeconds }
			: {}),
		...(input.provisioner !== undefined
			? { provisioner: input.provisioner }
			: {}),
		...(input.settings !== undefined ? { settings: input.settings } : {}),
		...(input.poolerEnabled !== undefined
			? { pooler_enabled: input.poolerEnabled }
			: {}),
		...(input.poolerMode !== undefined
			? { pooler_mode: input.poolerMode }
			: {}),
		...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
		...(input.passwordlessAccess !== undefined
			? { passwordless_access: input.passwordlessAccess }
			: {}),
	};
}

function mapEndpointUpdate(input: EndpointUpdateInput) {
	return {
		...(input.branchId !== undefined ? { branch_id: input.branchId } : {}),
		...(input.name !== undefined ? { name: input.name } : {}),
		...(input.compute?.minCu !== undefined
			? { autoscaling_limit_min_cu: input.compute.minCu }
			: {}),
		...(input.compute?.maxCu !== undefined
			? { autoscaling_limit_max_cu: input.compute.maxCu }
			: {}),
		...(input.compute?.suspendTimeoutSeconds !== undefined
			? { suspend_timeout_seconds: input.compute.suspendTimeoutSeconds }
			: {}),
		...(input.provisioner !== undefined
			? { provisioner: input.provisioner }
			: {}),
		...(input.settings !== undefined ? { settings: input.settings } : {}),
		...(input.poolerEnabled !== undefined
			? { pooler_enabled: input.poolerEnabled }
			: {}),
		...(input.poolerMode !== undefined
			? { pooler_mode: input.poolerMode }
			: {}),
		...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
		...(input.passwordlessAccess !== undefined
			? { passwordless_access: input.passwordlessAccess }
			: {}),
	};
}

/** Compute endpoint resource (project-scoped). */
export class Endpoints<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/endpoints */
	list(projectId: string): Promise<Outcome<Endpoint[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		projectId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint[], Throw>>;
	list(
		projectId: string,
		opts?: CallOptions,
	): Promise<Endpoint[] | NeonResult<Endpoint[]>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				listProjectEndpoints({
					client,
					path: { project_id: projectId },
					throwOnError: false,
					signal,
				}),
			(data) => data.endpoints,
		);
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/endpoints */
	listByBranch(
		projectId: string,
		branchId: string,
	): Promise<Outcome<Endpoint[], DThrow>>;
	listByBranch<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint[], Throw>>;
	listByBranch(
		projectId: string,
		branchId: string,
		opts?: CallOptions,
	): Promise<Endpoint[] | NeonResult<Endpoint[]>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				listProjectBranchEndpoints({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data.endpoints,
		);
	}

	/** @apiCall GET /projects/{project_id}/endpoints/{endpoint_id} */
	get(
		projectId: string,
		endpointId: string,
	): Promise<Outcome<Endpoint, DThrow>>;
	get<Throw extends boolean = DThrow>(
		projectId: string,
		endpointId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint, Throw>>;
	get(
		projectId: string,
		endpointId: string,
		opts?: CallOptions,
	): Promise<Endpoint | NeonResult<Endpoint>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProjectEndpoint({
					client,
					path: { project_id: projectId, endpoint_id: endpointId },
					throwOnError: false,
					signal,
				}),
			(data) => data.endpoint,
		);
	}

	/** @apiCall POST /projects/{project_id}/endpoints */
	create(
		projectId: string,
		input: EndpointCreateInput,
	): Promise<Outcome<Endpoint, DThrow>>;
	create<Throw extends boolean = DThrow>(
		projectId: string,
		input: EndpointCreateInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint, Throw>>;
	create(
		projectId: string,
		input: EndpointCreateInput,
		opts?: CallOptions,
	): Promise<Endpoint | NeonResult<Endpoint>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				createProjectEndpoint({
					client,
					path: { project_id: projectId },
					body: { endpoint: mapEndpointCreate(input) },
					throwOnError: false,
					signal,
				}),
			(data) => data.endpoint,
		);
	}

	/** @apiCall PATCH /projects/{project_id}/endpoints/{endpoint_id} */
	update(
		projectId: string,
		endpointId: string,
		input: EndpointUpdateInput,
	): Promise<Outcome<Endpoint, DThrow>>;
	update<Throw extends boolean = DThrow>(
		projectId: string,
		endpointId: string,
		input: EndpointUpdateInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint, Throw>>;
	update(
		projectId: string,
		endpointId: string,
		input: EndpointUpdateInput,
		opts?: CallOptions,
	): Promise<Endpoint | NeonResult<Endpoint>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateProjectEndpoint({
					client,
					path: { project_id: projectId, endpoint_id: endpointId },
					body: { endpoint: mapEndpointUpdate(input) },
					throwOnError: false,
					signal,
				}),
			(data) => data.endpoint,
		);
	}

	/** @apiCall DELETE /projects/{project_id}/endpoints/{endpoint_id} */
	delete(
		projectId: string,
		endpointId: string,
	): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		projectId: string,
		endpointId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		projectId: string,
		endpointId: string,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		return this.#ctx.runVoid(opts, (client, signal) =>
			deleteProjectEndpoint({
				client,
				path: { project_id: projectId, endpoint_id: endpointId },
				throwOnError: false,
				signal,
			}),
		);
	}

	/** @apiCall POST /projects/{project_id}/endpoints/{endpoint_id}/start */
	start(
		projectId: string,
		endpointId: string,
	): Promise<Outcome<Endpoint, DThrow>>;
	start<Throw extends boolean = DThrow>(
		projectId: string,
		endpointId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint, Throw>>;
	start(
		projectId: string,
		endpointId: string,
		opts?: CallOptions,
	): Promise<Endpoint | NeonResult<Endpoint>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				startProjectEndpoint({
					client,
					path: { project_id: projectId, endpoint_id: endpointId },
					throwOnError: false,
					signal,
				}),
			(data) => data.endpoint,
		);
	}

	/** @apiCall POST /projects/{project_id}/endpoints/{endpoint_id}/suspend */
	suspend(
		projectId: string,
		endpointId: string,
	): Promise<Outcome<Endpoint, DThrow>>;
	suspend<Throw extends boolean = DThrow>(
		projectId: string,
		endpointId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint, Throw>>;
	suspend(
		projectId: string,
		endpointId: string,
		opts?: CallOptions,
	): Promise<Endpoint | NeonResult<Endpoint>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				suspendProjectEndpoint({
					client,
					path: { project_id: projectId, endpoint_id: endpointId },
					throwOnError: false,
					signal,
				}),
			(data) => data.endpoint,
		);
	}

	/** @apiCall POST /projects/{project_id}/endpoints/{endpoint_id}/restart */
	restart(
		projectId: string,
		endpointId: string,
	): Promise<Outcome<Endpoint, DThrow>>;
	restart<Throw extends boolean = DThrow>(
		projectId: string,
		endpointId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint, Throw>>;
	restart(
		projectId: string,
		endpointId: string,
		opts?: CallOptions,
	): Promise<Endpoint | NeonResult<Endpoint>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				restartProjectEndpoint({
					client,
					path: { project_id: projectId, endpoint_id: endpointId },
					throwOnError: false,
					signal,
				}),
			(data) => data.endpoint,
		);
	}
}
