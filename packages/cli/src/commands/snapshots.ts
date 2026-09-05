import type {
	BackupScheduleItem,
	Operation,
	Snapshot,
	SnapshotFrequency,
} from "@neon/sdk";
import type yargs from "yargs";
import { retryOnLock } from "../api.js";
import { log } from "../log.js";
import type { ProjectScopeProps } from "../types.js";
import {
	branchIdResolve,
	fillSingleProject,
	resolveBranchRef,
} from "../utils/enrichers.js";
import { looksLikeLSN, looksLikeTimestamp } from "../utils/formats.js";
import { writer } from "../writer.js";
import { BRANCH_FIELDS } from "./branches.js";

export const SNAPSHOT_FIELDS: readonly (keyof Snapshot)[] = [
	"id",
	"name",
	"source_branch_id",
	"expires_at",
	"created_at",
];

const SCHEDULE_FIELDS: readonly (keyof BackupScheduleItem)[] = [
	"frequency",
	"hour",
	"day",
	"month",
	"retention_seconds",
];

const OPERATION_FIELDS: readonly (keyof Operation)[] = [
	"id",
	"action",
	"status",
];

// The values the Neon API accepts for a backup-schedule entry's `frequency`
// (per the OpenAPI `BackupScheduleItem` description). `satisfies` fails the
// build if a value listed here leaves the SDK's `SnapshotFrequency` union, so
// the CLI can never offer a frequency the API rejects.
const SNAPSHOT_FREQUENCIES = [
	"daily",
	"weekly",
	"monthly",
] as const satisfies readonly SnapshotFrequency[];

/** Narrow an arbitrary string to a supported {@link SnapshotFrequency}. */
const isSnapshotFrequency = (value: string): value is SnapshotFrequency =>
	SNAPSHOT_FREQUENCIES.some((frequency) => frequency === value);

export const command = "snapshots";
export const describe = "Manage snapshots";
export const aliases = ["snapshot"];

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 snapshots <sub-command> [options]")
		.options({
			"project-id": {
				describe: "Project ID",
				type: "string",
			},
		})
		.middleware(fillSingleProject as any)
		.command(
			"list",
			"List snapshots in the project",
			(yargs) => yargs,
			(args) => list(args as any),
		)
		.command(
			"get <id>",
			"Get a snapshot by id or name",
			(yargs) => yargs,
			(args) => get(args as any),
		)
		.command(
			"create",
			"Create a snapshot from a branch",
			(yargs) =>
				yargs
					.options({
						branch: {
							alias: "b",
							describe:
								"Branch id or name to snapshot. Defaults to the branch in your context, or the project's default branch.",
							type: "string",
						},
						name: {
							describe: "A name for the snapshot",
							type: "string",
						},
						timestamp: {
							describe:
								"Take the snapshot at this point in time (RFC 3339, e.g. 2025-01-01T00:00:00Z). Must fall within the branch's restore window. Mutually exclusive with --lsn.",
							type: "string",
						},
						lsn: {
							describe:
								"Take the snapshot at this LSN (e.g. 0/1F3C8A0). Must fall within the branch's restore window. Mutually exclusive with --timestamp.",
							type: "string",
						},
						"expires-at": {
							describe:
								"When the snapshot is automatically deleted (RFC 3339, e.g. 2025-12-31T23:59:59Z). Omit to keep it indefinitely.",
							type: "string",
						},
					})
					.conflicts("timestamp", "lsn")
					.example([
						[
							"$0 snapshots create",
							"Snapshot the head of the context/default branch",
						],
						[
							"$0 snapshots create --branch main --name pre-migration",
							"Snapshot the head of main with a name",
						],
						[
							"$0 snapshots create --branch main --timestamp 2025-01-01T00:00:00Z",
							"Snapshot main at a point in time",
						],
						[
							"$0 snapshots create --branch main --lsn 0/1F3C8A0 --expires-at 2025-12-31T23:59:59Z",
							"Snapshot main at an LSN, auto-deleting at the given time",
						],
					]),
			(args) => create(args as any),
		)
		.command(
			"update <id>",
			"Update a snapshot's name or expiration",
			(yargs) =>
				yargs
					.options({
						name: {
							describe: "Rename the snapshot",
							type: "string",
						},
						"expires-at": {
							describe:
								"Set when the snapshot expires (RFC 3339). Mutually exclusive with --clear-expiration.",
							type: "string",
						},
						"clear-expiration": {
							describe:
								"Clear the expiration so the snapshot is kept indefinitely.",
							type: "boolean",
						},
					})
					.conflicts("expires-at", "clear-expiration"),
			(args) => update(args as any),
		)
		.command(
			"delete <id>",
			"Delete a snapshot by id or name",
			(yargs) => yargs,
			(args) => deleteSnapshot(args as any),
		)
		.command(
			"restore <id>",
			"Restore a snapshot into a branch",
			(yargs) =>
				yargs
					.options({
						name: {
							describe:
								"Name for the newly restored branch. Auto-generated when omitted.",
							type: "string",
						},
						"target-branch": {
							describe:
								"Branch id or name to restore the snapshot onto. Defaults to the snapshot's source branch. Recommended when you intend to finalize (replace an existing branch).",
							type: "string",
						},
						finalize: {
							describe:
								"Finalize the restore immediately: move computes onto the restored branch and swap it in for the target. Without this, the restore is left un-finalized so you can inspect it first, then run `snapshots finalize <branch>`.",
							type: "boolean",
							default: false,
						},
					})
					.example([
						[
							"$0 snapshots restore snap-1234 --name recovered",
							"Restore a snapshot to a new branch named 'recovered'",
						],
						[
							"$0 snapshots restore snap-1234 --target-branch main --finalize",
							"Restore onto main and swap it in immediately",
						],
						[
							"$0 snapshots restore snap-1234 --target-branch main",
							"Restore onto main un-finalized to preview, then run `snapshots finalize`",
						],
					]),
			(args) => restore(args as any),
		)
		.command(
			"finalize <branch>",
			"Finalize a previewed snapshot restore (swap the restored branch in)",
			(yargs) =>
				yargs.options({
					name: {
						describe:
							"Name to give the replaced (old) branch. Auto-generated when omitted.",
						type: "string",
					},
				}),
			(args) => finalize(args as any),
		)
		.command(
			"schedule",
			"Manage the automatic snapshot (backup) schedule of a branch",
			(yargs) =>
				yargs
					.usage("$0 snapshots schedule <sub-command> [options]")
					.command(
						"get",
						"Get a branch's automatic snapshot schedule",
						(yargs) =>
							yargs.options({
								branch: {
									alias: "b",
									describe:
										"Branch id or name. Defaults to the branch in your context, or the project's default branch.",
									type: "string",
								},
							}),
						(args) => scheduleGet(args as any),
					)
					.command(
						"set",
						"Set a branch's automatic snapshot schedule",
						(yargs) =>
							yargs
								.options({
									branch: {
										alias: "b",
										describe:
											"Branch id or name. Defaults to the branch in your context, or the project's default branch.",
										type: "string",
									},
									frequency: {
										describe:
											"How often to take snapshots. Builds a single-entry schedule together with --hour/--day/--month/--retention.",
										choices: SNAPSHOT_FREQUENCIES,
										type: "string",
									},
									hour: {
										describe:
											"Hour of the day (0-23) to take the snapshot (used with --frequency).",
										type: "number",
									},
									day: {
										describe:
											"Day of the week/month (1-31) to take the snapshot (used with --frequency).",
										type: "number",
									},
									month: {
										describe:
											"Month of the year (1-12) to take the snapshot (used with --frequency).",
										type: "number",
									},
									retention: {
										describe:
											"How long to keep each snapshot, in seconds (min 3600). Omit to keep indefinitely.",
										type: "number",
									},
									schedule: {
										describe:
											'Full schedule as JSON, for multi-entry schedules, e.g. \'[{"frequency":"daily","hour":3,"retention_seconds":604800}]\'. Overrides the single-entry flags.',
										type: "string",
									},
								})
								.example([
									[
										"$0 snapshots schedule set --branch main --frequency daily --hour 3 --retention 604800",
										"A daily 03:00 snapshot kept for 7 days",
									],
									[
										'$0 snapshots schedule set --branch main --schedule \'[{"frequency":"weekly","day":1,"hour":2},{"frequency":"daily","hour":3}]\'',
										"A multi-entry schedule via JSON",
									],
								]),
						(args) => scheduleSet(args as any),
					)
					.demandCommand(1, "Specify `get` or `set`."),
			() => {},
		);

export const handler = (args: yargs.Argv) => {
	return args;
};

/** Narrow an unknown parsed JSON value to a plain object without type casting. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Normalize a user-supplied date to an ISO 8601 string, or throw a friendly error. */
const toIso = (value: string, flag: string): string => {
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) {
		throw new Error(
			`Invalid ${flag} value: "${value}". Use an RFC 3339 timestamp, e.g. 2025-12-31T23:59:59Z.`,
		);
	}
	return new Date(ms).toISOString();
};

/**
 * Resolve a snapshot from an id **or** a name. Snapshot names are not guaranteed
 * unique, so an id match wins; a name that resolves to more than one snapshot is a
 * hard error asking the user to disambiguate by id.
 */
const resolveSnapshot = async (
	props: ProjectScopeProps & { id: string },
): Promise<Snapshot> => {
	const {
		data: { snapshots },
	} = await props.apiClient.listSnapshots(props.projectId);

	const byId = snapshots.find((s: Snapshot) => s.id === props.id);
	if (byId) {
		return byId;
	}

	const byName = snapshots.filter((s: Snapshot) => s.name === props.id);
	if (byName.length === 1) {
		return byName[0];
	}
	if (byName.length > 1) {
		throw new Error(
			`Multiple snapshots are named "${props.id}". Re-run with the snapshot id:\n${byName
				.map((s: Snapshot) => `  ${s.id}`)
				.join("\n")}`,
		);
	}

	throw new Error(
		`Snapshot "${props.id}" not found.\nAvailable snapshots: ${
			snapshots.map((s: Snapshot) => `${s.name} (${s.id})`).join(", ") ||
			"none"
		}`,
	);
};

const list = async (props: ProjectScopeProps) => {
	const {
		data: { snapshots },
	} = await props.apiClient.listSnapshots(props.projectId);
	writer(props).end(snapshots, {
		fields: SNAPSHOT_FIELDS,
		title: "snapshots",
		emptyMessage:
			"No snapshots found. Create one with:\n> neon snapshots create --help",
		renderColumns: {
			expires_at: (s) => s.expires_at || "never",
		},
	});
};

const get = async (props: ProjectScopeProps & { id: string }) => {
	const snapshot = await resolveSnapshot(props);
	writer(props).end(snapshot, {
		fields: SNAPSHOT_FIELDS,
		renderColumns: {
			expires_at: (s) => s.expires_at || "never",
		},
	});
};

const create = async (
	props: ProjectScopeProps & {
		branch?: string;
		name?: string;
		timestamp?: string;
		lsn?: string;
		expiresAt?: string;
	},
) => {
	if (props.lsn !== undefined && !looksLikeLSN(props.lsn)) {
		throw new Error(
			`Invalid --lsn value: "${props.lsn}". Expected an LSN like 0/1F3C8A0.`,
		);
	}
	if (props.timestamp !== undefined && !looksLikeTimestamp(props.timestamp)) {
		throw new Error(
			`Invalid --timestamp value: "${props.timestamp}". Use an RFC 3339 timestamp, e.g. 2025-01-01T00:00:00Z.`,
		);
	}

	const { branchId } = await resolveBranchRef({
		...props,
		branch: props.branch,
	} as any);

	const { data } = await retryOnLock(() =>
		props.apiClient.createSnapshot(props.projectId, branchId, {
			name: props.name,
			timestamp: props.timestamp,
			lsn: props.lsn,
			expires_at: props.expiresAt
				? toIso(props.expiresAt, "--expires-at")
				: undefined,
		}),
	);

	writer(props).end(data.snapshot, {
		fields: SNAPSHOT_FIELDS,
		title: "snapshot",
		renderColumns: {
			expires_at: (s) => s.expires_at || "never",
		},
	});
};

const update = async (
	props: ProjectScopeProps & {
		id: string;
		name?: string;
		expiresAt?: string;
		clearExpiration?: boolean;
	},
) => {
	if (
		props.name === undefined &&
		props.expiresAt === undefined &&
		!props.clearExpiration
	) {
		throw new Error(
			"Nothing to update. Pass --name, --expires-at, or --clear-expiration.",
		);
	}

	const snapshot = await resolveSnapshot(props);

	// `undefined` fields are dropped by JSON serialization, so an omitted
	// `expires_at` leaves the expiration unchanged while an explicit `null`
	// clears it.
	const expiresAt = props.clearExpiration
		? null
		: props.expiresAt !== undefined
			? toIso(props.expiresAt, "--expires-at")
			: undefined;

	const { data } = await retryOnLock(() =>
		props.apiClient.updateSnapshot(props.projectId, snapshot.id, {
			snapshot: {
				name: props.name,
				expires_at: expiresAt,
			},
		}),
	);

	writer(props).end(data.snapshot, {
		fields: SNAPSHOT_FIELDS,
		renderColumns: {
			expires_at: (s) => s.expires_at || "never",
		},
	});
};

const deleteSnapshot = async (props: ProjectScopeProps & { id: string }) => {
	const snapshot = await resolveSnapshot(props);
	await retryOnLock(() =>
		props.apiClient.deleteSnapshot(props.projectId, snapshot.id),
	);
	// The delete endpoint returns the tracking operations (202), not the snapshot
	// body, so echo the snapshot we just deleted for confirmation.
	writer(props).end(snapshot, {
		fields: SNAPSHOT_FIELDS,
		renderColumns: {
			expires_at: (s) => s.expires_at || "never",
		},
	});
};

const restore = async (
	props: ProjectScopeProps & {
		id: string;
		name?: string;
		targetBranch?: string;
		finalize: boolean;
	},
) => {
	const snapshot = await resolveSnapshot(props);

	const targetBranchId = props.targetBranch
		? await branchIdResolve({
				branch: props.targetBranch,
				projectId: props.projectId,
				apiClient: props.apiClient,
			})
		: undefined;

	const { data } = await retryOnLock(() =>
		props.apiClient.restoreSnapshot(props.projectId, snapshot.id, {
			name: props.name,
			target_branch_id: targetBranchId,
			finalize_restore: props.finalize,
		}),
	);

	const out = writer(props).write(data.branch, {
		fields: BRANCH_FIELDS,
		title: "restored branch",
	});
	if (data.operations?.length) {
		out.write(data.operations, {
			fields: OPERATION_FIELDS,
			title: "operations",
		});
	}
	out.end();

	if (!props.finalize) {
		log.info(
			`Restore left un-finalized. Inspect branch ${data.branch.id}, then run:\n  neon snapshots finalize ${data.branch.id} --project-id ${props.projectId}`,
		);
	}
};

const finalize = async (
	props: ProjectScopeProps & { branch: string; name?: string },
) => {
	const branchId = await branchIdResolve({
		branch: props.branch,
		projectId: props.projectId,
		apiClient: props.apiClient,
	});

	const { data } = await retryOnLock(() =>
		props.apiClient.finalizeRestoreBranch(
			props.projectId,
			branchId,
			props.name ? { name: props.name } : undefined,
		),
	);

	writer(props).end(data.operations ?? [], {
		fields: OPERATION_FIELDS,
		title: "operations",
		emptyMessage: `Finalized restore for branch ${branchId}.`,
	});
};

const scheduleGet = async (props: ProjectScopeProps & { branch?: string }) => {
	const { branchId } = await resolveBranchRef({
		...props,
		branch: props.branch,
	} as any);
	const { data } = await props.apiClient.getSnapshotSchedule(
		props.projectId,
		branchId,
	);
	writer(props).end(data.schedule, {
		fields: SCHEDULE_FIELDS,
		title: "schedule",
		emptyMessage: "No automatic snapshot schedule is configured.",
	});
};

/**
 * Validate an untrusted parsed value as a {@link BackupScheduleItem}[] without any
 * type casting, throwing a clear error for the first invalid field it finds.
 */
const parseScheduleJson = (raw: string): BackupScheduleItem[] => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("--schedule must be valid JSON.");
	}
	if (!Array.isArray(parsed)) {
		throw new Error(
			'--schedule must be a JSON array of schedule entries, e.g. \'[{"frequency":"daily","hour":3}]\'.',
		);
	}

	return parsed.map((entry, index) => {
		if (!isRecord(entry)) {
			throw new Error(`--schedule entry ${index} must be an object.`);
		}
		const record = entry;
		const frequency = record.frequency;
		if (typeof frequency !== "string") {
			throw new Error(
				`--schedule entry ${index} is missing a string "frequency".`,
			);
		}
		if (!isSnapshotFrequency(frequency)) {
			throw new Error(
				`--schedule entry ${index} has an unsupported "frequency": "${frequency}". Use one of: ${SNAPSHOT_FREQUENCIES.join(", ")}.`,
			);
		}
		const item: BackupScheduleItem = { frequency };
		for (const key of [
			"hour",
			"day",
			"month",
			"retention_seconds",
		] as const) {
			const value = record[key];
			if (value === undefined) {
				continue;
			}
			if (typeof value !== "number") {
				throw new Error(
					`--schedule entry ${index} field "${key}" must be a number.`,
				);
			}
			item[key] = value;
		}
		return item;
	});
};

const scheduleSet = async (
	props: ProjectScopeProps & {
		branch?: string;
		frequency?: string;
		hour?: number;
		day?: number;
		month?: number;
		retention?: number;
		schedule?: string;
	},
) => {
	const { branchId } = await resolveBranchRef({
		...props,
		branch: props.branch,
	} as any);

	let schedule: BackupScheduleItem[];
	if (props.schedule) {
		schedule = parseScheduleJson(props.schedule);
	} else if (props.frequency) {
		const item: BackupScheduleItem = { frequency: props.frequency };
		if (props.hour !== undefined) item.hour = props.hour;
		if (props.day !== undefined) item.day = props.day;
		if (props.month !== undefined) item.month = props.month;
		if (props.retention !== undefined)
			item.retention_seconds = props.retention;
		schedule = [item];
	} else {
		throw new Error(
			"Provide --frequency (optionally with --hour/--day/--month/--retention) or --schedule <json>.",
		);
	}

	await retryOnLock(() =>
		props.apiClient.setSnapshotSchedule(props.projectId, branchId, {
			schedule,
		}),
	);

	writer(props).end(schedule, {
		fields: SCHEDULE_FIELDS,
		title: "schedule",
	});
};
