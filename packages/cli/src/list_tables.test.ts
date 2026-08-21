import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { API_ENDPOINT_FIELDS } from "./commands/api.js";
import { ACCOUNT_FIELDS, ORG_TABLE_FIELDS } from "./commands/api_keys.js";
import { BRANCH_FIELDS } from "./commands/branches.js";
import { BUCKET_FIELDS, OBJECT_FIELDS } from "./commands/bucket.js";
import { DATABASE_FIELDS } from "./commands/databases.js";
import { LIST_TABLE_FIELDS } from "./commands/functions.js";
import { LOG_FIELDS } from "./commands/logs.js";
import { DOMAIN_FIELDS, OAUTH_PROVIDER_FIELDS } from "./commands/neon_auth.js";
import { OPERATIONS_FIELDS } from "./commands/operations.js";
import { ORG_FIELDS } from "./commands/orgs.js";
import { PROFILE_LIST_FIELDS } from "./commands/profile.js";
import {
	PROJECT_FIELDS,
	RECOVERABLE_PROJECT_FIELDS,
} from "./commands/projects.js";
import { ROLES_FIELDS } from "./commands/roles.js";
import {
	OPERATION_FIELDS,
	SCHEDULE_FIELDS,
	SNAPSHOT_FIELDS,
} from "./commands/snapshots.js";
import { VPC_ENDPOINT_FIELDS } from "./commands/vpc_endpoints.js";
import { formatHumanChunk, planListLayout } from "./human_table.js";
import {
	INSPECT_QUERIES,
	type InspectSubcommand,
} from "./utils/inspect_queries.js";

const DESIGN_WIDTH = 120;
const NARROW_WIDTH = 80;

const SHRINKABLE_LAST = new Set([
	"query",
	"message",
	"diff",
	"invocation_url",
	"etag",
	"last_used_from_addr",
	"summary",
	"scope",
	"replication_lag",
	"recoverable_until",
]);

const TIMESTAMP = "2021-01-01T00:00:00.000Z";
const PROJECT_ID = "wandering-haze-25754674";
const BRANCH_ID = "br-main-branch-123456";
const REGION = "aws-us-east-2";

const INSPECT_FIXTURE_VALUES = {
	database: "neondb",
	schema: "public",
	name: "events",
	size: "128 MB",
	table: "public.events",
	index: "events_created_at_idx",
	index_size: "24 MB",
	index_scans: 12,
	count: 1842,
	pid: 1694,
	duration: "00:07:12.345",
	state: "active",
	query: "SELECT id FROM orders WHERE status = 'open'",
	relname: "orders",
	mode: "RowExclusiveLock",
	locktype: "relation",
	granted: true,
	age: "00:00:45.120",
	total_exec_time: "00:12:03.400",
	prop_exec_time: "38.2%",
	ncalls: 4210,
	ratio: 0.97,
	window: "15m",
	working_set: "2.1 GB",
	lfc_size: "1 GB",
	exceeds_lfc: "yes",
	last_vacuum: "2026-08-01 04:12",
	last_autovacuum: "2026-08-11 09:40",
	rowcount: 1_200_000,
	dead_rowcount: 48_000,
	expect_autovacuum: "yes",
	type: "table",
	object_name: "events",
	bloat: 2.4,
	waste: "180 MB",
	slot_name: "logical_cdc",
	slot_type: "logical",
	slot_kind: "CDC (apply)",
	status: "streaming",
	client_addr: "10.0.12.4",
	restart_lsn: "0/16B3748",
	confirmed_flush_lsn: "0/16B6A20",
	replication_lag: "12 MB",
	subscription: "orders_sub",
	table_name: "public.orders",
	lsn: "0/16B6A20",
} as const satisfies Record<string, unknown>;

type ListCase = {
	command: string;
	fields: readonly string[];
	data: readonly Record<string, unknown>[];
	renderColumns?: object;
	mustKeepAt80: readonly string[];
	keptAt80: readonly string[];
	mayDropAt120?: readonly string[];
};

const neverExpires = {
	expires_at: (row: { expires_at?: string | null }) =>
		row.expires_at || "never",
};

const branchName = (row: {
	name: string;
	default?: boolean;
	protected?: boolean;
}) => {
	const labels: string[] = [];
	if (row.default) {
		labels.push("[default]");
	}
	if (row.protected) {
		labels.push("[protected]");
	}
	labels.push(row.name);
	return labels.join(" ");
};

const inspectRow = (fields: readonly string[]): Record<string, unknown> => {
	const row: Record<string, unknown> = {};
	for (const field of fields) {
		if (!(field in INSPECT_FIXTURE_VALUES)) {
			throw new Error(
				`Add ${field} to INSPECT_FIXTURE_VALUES before declaring it on an inspect list.`,
			);
		}
		row[field] = Reflect.get(INSPECT_FIXTURE_VALUES, field);
	}
	return row;
};

const INSPECT_KEPT_AT_80 = {
	"inspect db table-sizes": ["schema", "name", "size"],
	"inspect db table-sizes (all databases)": [
		"database",
		"schema",
		"name",
		"size",
	],
	"inspect db index-sizes": ["schema", "name", "size"],
	"inspect db index-sizes (all databases)": [
		"database",
		"schema",
		"name",
		"size",
	],
	"inspect db unused-indexes": [
		"table",
		"index",
		"index_size",
		"index_scans",
	],
	"inspect db unused-indexes (all databases)": [
		"database",
		"table",
		"index",
		"index_size",
		"index_scans",
	],
	"inspect db seq-scans": ["schema", "name", "count"],
	"inspect db seq-scans (all databases)": [
		"database",
		"schema",
		"name",
		"count",
	],
	"inspect db long-running-queries": ["pid", "duration", "state", "query"],
	"inspect db long-running-queries (all databases)": [
		"database",
		"pid",
		"duration",
		"state",
		"query",
	],
	"inspect db locks": [
		"pid",
		"relname",
		"mode",
		"locktype",
		"granted",
		"age",
		"query",
	],
	"inspect db locks (all databases)": [
		"database",
		"pid",
		"relname",
		"mode",
		"locktype",
		"granted",
		"age",
		"query",
	],
	"inspect db outliers": [
		"total_exec_time",
		"prop_exec_time",
		"ncalls",
		"query",
	],
	"inspect db outliers (all databases)": [
		"database",
		"total_exec_time",
		"prop_exec_time",
		"ncalls",
		"query",
	],
	"inspect db calls": [
		"ncalls",
		"total_exec_time",
		"prop_exec_time",
		"query",
	],
	"inspect db calls (all databases)": [
		"database",
		"ncalls",
		"total_exec_time",
		"prop_exec_time",
		"query",
	],
	"inspect db lfc-hit-rate": ["name", "ratio"],
	"inspect db working-set": [
		"window",
		"working_set",
		"lfc_size",
		"exceeds_lfc",
	],
	"inspect db vacuum-stats": [
		"schema",
		"table",
		"last_vacuum",
		"last_autovacuum",
		"rowcount",
		"dead_rowcount",
	],
	"inspect db vacuum-stats (all databases)": [
		"database",
		"schema",
		"table",
		"last_vacuum",
		"last_autovacuum",
		"rowcount",
	],
	"inspect db bloat": ["type", "schema", "object_name", "bloat", "waste"],
	"inspect db bloat (all databases)": [
		"database",
		"type",
		"schema",
		"object_name",
		"bloat",
		"waste",
	],
	"inspect db replication-slots": [
		"slot_name",
		"slot_type",
		"slot_kind",
		"status",
		"client_addr",
		"restart_lsn",
		"confirmed_flush_lsn",
	],
	"inspect db subscriptions": ["subscription", "table_name", "status", "lsn"],
	"inspect db subscriptions (all databases)": [
		"database",
		"subscription",
		"table_name",
		"status",
		"lsn",
	],
} as const satisfies Record<string, readonly string[]>;

const inspectCases = (): ListCase[] => {
	const cases: ListCase[] = [];
	for (const name of Object.keys(INSPECT_QUERIES) as InspectSubcommand[]) {
		const query = INSPECT_QUERIES[name];
		const variants: { command: string; fields: readonly string[] }[] = [
			{ command: `inspect db ${name}`, fields: query.fields },
		];
		if (query.scope === "database") {
			variants.push({
				command: `inspect db ${name} (all databases)`,
				fields: ["database", ...query.fields],
			});
		}
		for (const variant of variants) {
			const last = variant.fields[variant.fields.length - 1];
			let mustKeepAt80 = SHRINKABLE_LAST.has(last ?? "")
				? variant.fields.slice(0, -1)
				: variant.fields;
			if (name === "vacuum-stats") {
				mustKeepAt80 = variant.fields.includes("database")
					? ["database", "schema", "table", "last_autovacuum"]
					: ["schema", "table", "last_autovacuum", "dead_rowcount"];
			}
			const keptAt80 = Reflect.get(INSPECT_KEPT_AT_80, variant.command);
			if (!Array.isArray(keptAt80)) {
				throw new Error(
					`Record the 80-column fields for ${variant.command} in INSPECT_KEPT_AT_80.`,
				);
			}
			cases.push({
				command: variant.command,
				fields: variant.fields,
				data: [inspectRow(variant.fields)],
				mustKeepAt80,
				keptAt80,
			});
		}
	}
	return cases;
};

const COMMAND_CASES: ListCase[] = [
	{
		command: "projects list",
		fields: PROJECT_FIELDS,
		data: [
			{
				id: PROJECT_ID,
				name: "claimable-neon-local-state",
				region_id: REGION,
				created_at: TIMESTAMP,
			},
		],
		mustKeepAt80: PROJECT_FIELDS,
		keptAt80: PROJECT_FIELDS,
	},
	{
		command: "projects list --recoverable-only",
		fields: RECOVERABLE_PROJECT_FIELDS,
		data: [
			{
				id: PROJECT_ID,
				name: "claimable-neon-local-state",
				region_id: REGION,
				created_at: TIMESTAMP,
				deleted_at: TIMESTAMP,
				recoverable_until: TIMESTAMP,
			},
		],
		mustKeepAt80: ["id", "name", "recoverable_until"],
		keptAt80: ["id", "name", "recoverable_until"],
		mayDropAt120: ["created_at"],
	},
	{
		command: "branches list",
		fields: BRANCH_FIELDS,
		data: [
			{
				name: "main",
				id: BRANCH_ID,
				current_state: "ready",
				created_at: TIMESTAMP,
				expires_at: null,
				default: true,
			},
		],
		renderColumns: {
			expires_at: neverExpires.expires_at,
			name: branchName,
		},
		mustKeepAt80: ["name", "id", "current_state", "expires_at"],
		keptAt80: ["name", "id", "current_state", "expires_at", "created_at"],
	},
	{
		command: "databases list",
		fields: DATABASE_FIELDS,
		data: [
			{
				name: "neondb",
				owner_name: "neondb_owner",
				created_at: TIMESTAMP,
			},
		],
		mustKeepAt80: DATABASE_FIELDS,
		keptAt80: DATABASE_FIELDS,
	},
	{
		command: "roles list",
		fields: ROLES_FIELDS,
		data: [{ name: "neondb_owner", created_at: TIMESTAMP }],
		mustKeepAt80: ROLES_FIELDS,
		keptAt80: ROLES_FIELDS,
	},
	{
		command: "orgs list",
		fields: ORG_FIELDS,
		data: [{ id: "org-example-12345678", name: "Personal" }],
		mustKeepAt80: ORG_FIELDS,
		keptAt80: ORG_FIELDS,
	},
	{
		command: "operations list",
		fields: OPERATIONS_FIELDS,
		data: [
			{
				id: "op-create-project-123456",
				action: "create_project",
				status: "finished",
				created_at: TIMESTAMP,
			},
		],
		mustKeepAt80: OPERATIONS_FIELDS,
		keptAt80: OPERATIONS_FIELDS,
	},
	{
		command: "api-keys list",
		fields: ACCOUNT_FIELDS,
		data: [
			{
				id: 301,
				name: "laptop",
				created_at: TIMESTAMP,
				last_used_at: TIMESTAMP,
				last_used_from_addr: "203.0.113.10",
			},
		],
		mustKeepAt80: ["id", "name", "created_at", "last_used_at"],
		keptAt80: ACCOUNT_FIELDS,
	},
	{
		command: "api-keys list --org-id",
		fields: ORG_TABLE_FIELDS,
		data: [
			{
				id: 302,
				name: "ci",
				project: "all projects",
				created_at: TIMESTAMP,
				last_used_at: TIMESTAMP,
				last_used_from_addr: "203.0.113.10",
			},
		],
		mustKeepAt80: ["id", "name", "project", "created_at", "last_used_at"],
		keptAt80: ORG_TABLE_FIELDS,
	},
	{
		command: "profile list",
		fields: PROFILE_LIST_FIELDS,
		data: [
			{
				active: "*",
				name: "default",
				account: "andre@example.com",
				auth: "oauth",
				credentials: "~/.config/neonctl/credentials",
				scope: "personal",
			},
		],
		mustKeepAt80: ["active", "name", "account", "auth", "credentials"],
		keptAt80: PROFILE_LIST_FIELDS,
	},
	{
		command: "snapshots list",
		fields: SNAPSHOT_FIELDS,
		data: [
			{
				id: "snap-main-123456",
				name: "nightly",
				source_branch_id: BRANCH_ID,
				created_at: TIMESTAMP,
				expires_at: null,
			},
		],
		renderColumns: neverExpires,
		mustKeepAt80: ["id", "name", "source_branch_id", "created_at"],
		keptAt80: SNAPSHOT_FIELDS,
	},
	{
		command: "snapshots schedule get",
		fields: SCHEDULE_FIELDS,
		data: [
			{
				frequency: "daily",
				hour: 3,
				day: 1,
				month: 1,
				retention_seconds: 604800,
			},
		],
		mustKeepAt80: SCHEDULE_FIELDS,
		keptAt80: SCHEDULE_FIELDS,
	},
	{
		command: "snapshots restore (operations)",
		fields: OPERATION_FIELDS,
		data: [
			{
				id: "op-restore-snapshot-123456",
				action: "restore_snapshot",
				status: "running",
			},
		],
		mustKeepAt80: OPERATION_FIELDS,
		keptAt80: OPERATION_FIELDS,
	},
	{
		command: "functions list",
		fields: LIST_TABLE_FIELDS,
		data: [
			{
				slug: "resize",
				name: "resize",
				status: "active",
				invocation_url:
					"https://fn.neon.tech/v1/resize?project=wandering-haze",
				created_at: TIMESTAMP,
			},
		],
		mustKeepAt80: ["slug", "name", "status"],
		keptAt80: ["slug", "name", "status", "invocation_url"],
	},
	{
		command: "logs query",
		fields: LOG_FIELDS,
		data: [
			{
				timestamp: "2026-08-17T15:04:05.123Z",
				source: "postgres",
				service_name: "compute",
				severity_text: "ERROR",
				message:
					'ERROR: relation "orders" does not exist at character 15',
			},
		],
		mustKeepAt80: ["timestamp", "source", "service_name", "severity_text"],
		keptAt80: LOG_FIELDS,
	},
	{
		command: "logs fields",
		fields: ["field"],
		data: [{ field: "severity_text" }],
		mustKeepAt80: ["field"],
		keptAt80: ["field"],
	},
	{
		command: "vpc-endpoints list",
		fields: VPC_ENDPOINT_FIELDS,
		data: [
			{
				vpc_endpoint_id: "vpce-0a1b2c3d4e5f6g7h8",
				label: "prod-vpc",
			},
		],
		mustKeepAt80: VPC_ENDPOINT_FIELDS,
		keptAt80: VPC_ENDPOINT_FIELDS,
	},
	{
		command: "bucket list",
		fields: BUCKET_FIELDS,
		data: [{ name: "assets", access_level: "read_write" }],
		mustKeepAt80: BUCKET_FIELDS,
		keptAt80: BUCKET_FIELDS,
	},
	{
		command: "bucket object list (folders)",
		fields: ["name"],
		data: [{ name: "images/" }],
		mustKeepAt80: ["name"],
		keptAt80: ["name"],
	},
	{
		command: "bucket object list (objects)",
		fields: OBJECT_FIELDS,
		data: [
			{
				key: "images/hero.png",
				size: 184320,
				last_modified: TIMESTAMP,
				etag: "a1b2c3d4e5f6",
			},
		],
		mustKeepAt80: ["key", "size", "last_modified"],
		keptAt80: OBJECT_FIELDS,
	},
	{
		command: "api --list",
		fields: API_ENDPOINT_FIELDS,
		data: [
			{
				method: "GET",
				path: "/projects/{project_id}/branches",
				summary: "Retrieves a list of branches",
			},
		],
		mustKeepAt80: ["method", "path"],
		keptAt80: API_ENDPOINT_FIELDS,
	},
	{
		command: "auth oauth-providers list",
		fields: OAUTH_PROVIDER_FIELDS,
		data: [
			{
				id: "google",
				type: "shared",
				client_id: "1234567890-abcdef.apps.googleusercontent.com",
			},
		],
		mustKeepAt80: OAUTH_PROVIDER_FIELDS,
		keptAt80: OAUTH_PROVIDER_FIELDS,
	},
	{
		command: "auth domains list",
		fields: DOMAIN_FIELDS,
		data: [{ domain: "https://app.example.com" }],
		mustKeepAt80: DOMAIN_FIELDS,
		keptAt80: DOMAIN_FIELDS,
	},
];

const LIST_CASES = [...COMMAND_CASES, ...inspectCases()];

describe("list table columns", () => {
	it("covers every inspect query, including the all-databases field list", () => {
		const names = new Set(LIST_CASES.map((listCase) => listCase.command));
		for (const name of Object.keys(
			INSPECT_QUERIES,
		) as InspectSubcommand[]) {
			expect(names.has(`inspect db ${name}`)).toBe(true);
			if (INSPECT_QUERIES[name].scope === "database") {
				expect(names.has(`inspect db ${name} (all databases)`)).toBe(
					true,
				);
			}
		}
	});

	it.each(LIST_CASES)("$command fits declared fields at 120", (listCase) => {
		const plan = planListLayout({
			data: listCase.data,
			fields: listCase.fields,
			width: DESIGN_WIDTH,
			renderColumns: listCase.renderColumns,
		});
		expect(plan).toBeDefined();
		if (plan === undefined) {
			return;
		}
		const mayDrop = listCase.mayDropAt120 ?? [];
		expect([...plan.dropped]).toEqual([...mayDrop]);
		expect([...plan.fields]).toEqual(
			listCase.fields.filter((field) => !mayDrop.includes(field)),
		);
		if (plan.mode === "shrink-last") {
			const last = plan.fields[plan.fields.length - 1];
			expect(SHRINKABLE_LAST.has(last ?? "")).toBe(true);
		}
	});

	it.each(
		LIST_CASES,
	)("$command shows a recorded 80-column field list", (listCase) => {
		const plan = planListLayout({
			data: listCase.data,
			fields: listCase.fields,
			width: NARROW_WIDTH,
			renderColumns: listCase.renderColumns,
		});
		expect(plan).toBeDefined();
		if (plan === undefined) {
			return;
		}
		expect([...plan.fields]).toEqual([...listCase.keptAt80]);
		for (const field of listCase.mustKeepAt80) {
			expect(plan.fields).toContain(field);
		}
	});

	it("keeps Expires At on branches list at 80 columns", () => {
		const listCase = LIST_CASES.find(
			(entry) => entry.command === "branches list",
		);
		expect(listCase).toBeDefined();
		if (listCase === undefined) {
			return;
		}
		const out = formatHumanChunk({
			data: listCase.data,
			fields: listCase.fields,
			width: NARROW_WIDTH,
			renderColumns: listCase.renderColumns,
			colorTitle: false,
		});
		expect(stripAnsi(out)).toMatch(/Expires At/);
		expect(stripAnsi(out)).toMatch(/never/);
	});
});
