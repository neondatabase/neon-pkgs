import type {
	ScheduleTriggerCreateRequest,
	ScheduleTriggerUpdateRequest,
	StorageObjectCreatedTriggerUpdateRequest,
	Trigger,
	TriggerUpdateRequest,
} from "@neon/sdk";
import type yargs from "yargs";
import { isNeonApiError, messageFromBody, retryOnLock } from "../api.js";
import { log } from "../log.js";
import type { BranchScopeProps } from "../types.js";
import { branchIdFromProps, fillSingleProject } from "../utils/enrichers.js";
import { writer } from "../writer.js";

// The backend's 404 for a missing trigger. Matched exactly so an ambiguous
// `update` 404 for a missing *function* ("target function not visible on
// branch") passes through untranslated instead of being mislabeled.
const TRIGGER_NOT_FOUND_MESSAGE = "function trigger not visible on branch";

/** Translate the trigger-not-found 404 into a resource-specific message; re-throw everything else. */
async function withTriggerNotFound<T>(
	triggerId: string,
	branchId: string,
	run: () => Promise<T>,
): Promise<T> {
	try {
		return await run();
	} catch (err) {
		if (
			isNeonApiError(err) &&
			err.status === 404 &&
			messageFromBody(err.data) === TRIGGER_NOT_FOUND_MESSAGE
		) {
			throw new Error(
				`Trigger ${triggerId} not found on branch ${branchId}.`,
			);
		}
		throw err;
	}
}

const TRIGGER_COMMON_FIELDS = [
	"trigger_id",
	"name",
	"function_slug",
	"function_path",
	"enabled",
	"inherited",
] as const;

type TriggerTableRow = {
	trigger_id: string;
	name: string;
	function_slug: string;
	function_path: string;
	schedule: string;
	enabled: boolean;
	inherited: boolean;
	next_run_at: string;
};

export const TRIGGER_FIELDS = [
	"trigger_id",
	"name",
	"function_slug",
	"function_path",
	"schedule",
	"enabled",
	"inherited",
	"next_run_at",
] as const satisfies readonly (keyof TriggerTableRow)[];

function triggerTableRow(t: Trigger): TriggerTableRow {
	if (t.type === "schedule") {
		return {
			trigger_id: t.trigger_id,
			name: t.name,
			function_slug: t.function_slug,
			function_path: t.function_path,
			schedule: t.schedule.cron,
			enabled: t.enabled,
			inherited: t.inherited,
			next_run_at: t.next_run_at ?? "",
		};
	}
	return {
		trigger_id: t.trigger_id,
		name: t.name,
		function_slug: t.function_slug,
		function_path: t.function_path,
		schedule: "",
		enabled: t.enabled,
		inherited: t.inherited,
		next_run_at: "",
	};
}

function writeTrigger(
	props: BranchScopeProps,
	data: Trigger | Trigger[],
	extra?: { emptyMessage: string },
) {
	if (props.output !== "table") {
		writer(props).end(data, {
			fields: TRIGGER_COMMON_FIELDS,
			...extra,
		});
		return;
	}
	const rows = Array.isArray(data)
		? data.map(triggerTableRow)
		: triggerTableRow(data);
	writer(props).end(rows, {
		fields: TRIGGER_FIELDS,
		...extra,
	});
}

function enabledPatch(
	type: Trigger["type"],
	enabled: boolean,
): TriggerUpdateRequest {
	if (type === "schedule") {
		return { type: "schedule", enabled };
	}
	return { type: "storage_object_created", enabled };
}

function updatePatch(
	type: Trigger["type"],
	props: UpdateProps,
): TriggerUpdateRequest {
	if (type === "schedule") {
		const body: ScheduleTriggerUpdateRequest = { type: "schedule" };
		if (props["function-slug"] !== undefined) {
			body.function_slug = props["function-slug"];
		}
		if (props.name !== undefined) body.name = props.name;
		if (props.cron !== undefined) body.schedule = { cron: props.cron };
		if (props["function-path"] !== undefined) {
			body.function_path = props["function-path"];
		}
		if (props.enabled !== undefined) body.enabled = props.enabled;
		return body;
	}
	const body: StorageObjectCreatedTriggerUpdateRequest = {
		type: "storage_object_created",
	};
	if (props["function-slug"] !== undefined) {
		body.function_slug = props["function-slug"];
	}
	if (props.name !== undefined) body.name = props.name;
	if (props["function-path"] !== undefined) {
		body.function_path = props["function-path"];
	}
	if (props.enabled !== undefined) body.enabled = props.enabled;
	return body;
}

type CreateProps = BranchScopeProps & {
	"function-slug": string;
	name: string;
	cron: string;
	"function-path"?: string;
	enabled?: boolean;
};

type UpdateProps = BranchScopeProps & {
	id: string;
	"function-slug"?: string;
	name?: string;
	cron?: string;
	"function-path"?: string;
	enabled?: boolean;
};

export const command = "triggers";
export const describe = "Manage function triggers";
export const aliases = ["trigger"];
export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 triggers <sub-command> [options]")
		.options({
			"project-id": {
				describe: "Project ID",
				type: "string",
			},
			branch: {
				describe: "Branch ID or name",
				type: "string",
			},
		})
		.middleware(fillSingleProject as any)
		.command(
			"list",
			"List triggers on the branch",
			(yargs) => yargs,
			(args) => list(args as any),
		)
		.command(
			"get <id>",
			"Show a trigger",
			(yargs) =>
				yargs.positional("id", {
					describe: "Trigger ID",
					type: "string",
				}),
			(args) => get(args as any),
		)
		.command(
			"create",
			"Create a trigger that invokes a function on a cron schedule",
			(yargs) =>
				yargs.options({
					"function-slug": {
						describe: "Slug of the function to invoke",
						type: "string",
						demandOption: true,
					},
					name: {
						describe: "Trigger name (unique per branch)",
						type: "string",
						demandOption: true,
					},
					cron: {
						describe:
							"Five-field UTC cron expression, e.g. '*/15 * * * *'",
						type: "string",
						demandOption: true,
					},
					"function-path": {
						describe:
							"Path the invocation is sent to (default '/')",
						type: "string",
					},
					enabled: {
						describe: "Whether the trigger runs (default true)",
						type: "boolean",
					},
				}),
			(args) => create(args as any),
		)
		.command(
			"update <id>",
			"Update a trigger",
			(yargs) =>
				yargs
					.positional("id", {
						describe: "Trigger ID",
						type: "string",
					})
					.options({
						"function-slug": {
							describe: "Slug of the function to invoke",
							type: "string",
						},
						name: {
							describe: "Trigger name (unique per branch)",
							type: "string",
						},
						cron: {
							describe: "Five-field UTC cron expression",
							type: "string",
						},
						"function-path": {
							describe: "Path the invocation is sent to",
							type: "string",
						},
						enabled: {
							describe: "Whether the trigger runs",
							type: "boolean",
						},
					}),
			(args) => update(args as any),
		)
		.command(
			"enable <id>",
			"Enable a trigger",
			(yargs) =>
				yargs.positional("id", {
					describe: "Trigger ID",
					type: "string",
				}),
			(args) => setEnabled(args as any, true),
		)
		.command(
			"disable <id>",
			"Disable a trigger without deleting it",
			(yargs) =>
				yargs.positional("id", {
					describe: "Trigger ID",
					type: "string",
				}),
			(args) => setEnabled(args as any, false),
		)
		.command(
			"delete <id>",
			"Delete a trigger",
			(yargs) =>
				yargs.positional("id", {
					describe: "Trigger ID",
					type: "string",
				}),
			(args) => deleteTrigger(args as any),
		);

export const handler = (args: yargs.Argv) => {
	return args;
};

export const list = async (props: BranchScopeProps) => {
	const branchId = await branchIdFromProps(props);
	const { data } = await props.apiClient.listProjectBranchTriggers(
		props.projectId,
		branchId,
	);
	writeTrigger(props, data.triggers, {
		emptyMessage: "No triggers found on this branch.",
	});
};

export const get = async (props: BranchScopeProps & { id: string }) => {
	const branchId = await branchIdFromProps(props);
	const { data } = await withTriggerNotFound(props.id, branchId, () =>
		props.apiClient.getProjectBranchTrigger(
			props.projectId,
			branchId,
			props.id,
		),
	);
	writeTrigger(props, data.trigger);
};

export const create = async (props: CreateProps) => {
	const branchId = await branchIdFromProps(props);
	const body: ScheduleTriggerCreateRequest = {
		type: "schedule",
		function_slug: props["function-slug"],
		name: props.name,
		schedule: { cron: props.cron },
	};
	if (props["function-path"] !== undefined) {
		body.function_path = props["function-path"];
	}
	if (props.enabled !== undefined) {
		body.enabled = props.enabled;
	}
	const { data } = await retryOnLock(() =>
		props.apiClient.createProjectBranchTrigger(
			props.projectId,
			branchId,
			body,
		),
	);
	writeTrigger(props, data.trigger);
};

export const update = async (props: UpdateProps) => {
	const branchId = await branchIdFromProps(props);
	const { data: existing } = await withTriggerNotFound(
		props.id,
		branchId,
		() =>
			props.apiClient.getProjectBranchTrigger(
				props.projectId,
				branchId,
				props.id,
			),
	);
	const trigger = existing.trigger;
	if (props.cron !== undefined && trigger.type !== "schedule") {
		throw new Error(
			`Trigger ${props.id} is type ${trigger.type}; --cron applies to schedule triggers.`,
		);
	}

	const body = updatePatch(trigger.type, props);
	const changed = Object.keys(body).filter((k) => k !== "type");
	if (changed.length === 0) {
		throw new Error(
			"No fields to update. Pass at least one of --function-slug, --name, --cron, --function-path, or --enabled.",
		);
	}

	const { data } = await withTriggerNotFound(props.id, branchId, () =>
		retryOnLock(() =>
			props.apiClient.updateProjectBranchTrigger(
				props.projectId,
				branchId,
				props.id,
				body,
			),
		),
	);
	writeTrigger(props, data.trigger);
};

const setEnabled = async (
	props: BranchScopeProps & { id: string },
	enabled: boolean,
) => {
	const branchId = await branchIdFromProps(props);
	const { data: existing } = await withTriggerNotFound(
		props.id,
		branchId,
		() =>
			props.apiClient.getProjectBranchTrigger(
				props.projectId,
				branchId,
				props.id,
			),
	);
	const { data } = await withTriggerNotFound(props.id, branchId, () =>
		retryOnLock(() =>
			props.apiClient.updateProjectBranchTrigger(
				props.projectId,
				branchId,
				props.id,
				enabledPatch(existing.trigger.type, enabled),
			),
		),
	);
	writeTrigger(props, data.trigger);
};

export const deleteTrigger = async (
	props: BranchScopeProps & { id: string },
) => {
	const branchId = await branchIdFromProps(props);
	await withTriggerNotFound(props.id, branchId, () =>
		retryOnLock(() =>
			props.apiClient.deleteProjectBranchTrigger(
				props.projectId,
				branchId,
				props.id,
			),
		),
	);
	log.info(`Trigger ${props.id} deleted`);
};
