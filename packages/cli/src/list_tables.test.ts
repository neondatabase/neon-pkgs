import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { BRANCH_FIELDS } from "./commands/branches.js";
import { CLAIM_LIST_FIELDS } from "./commands/claim.js";
import {
	PROJECT_FIELDS,
	RECOVERABLE_PROJECT_FIELDS,
} from "./commands/projects.js";
import { SNAPSHOT_FIELDS } from "./commands/snapshots.js";
import { formatHumanChunk } from "./human_table.js";
import {
	INSPECT_QUERIES,
	type InspectSubcommand,
} from "./utils/inspect_queries.js";

const TIMESTAMP = "2021-01-01T00:00:00.000Z";
const PROJECT_ID = "wandering-haze-25754674";
const BRANCH_ID = "br-main-branch-123456";
const REGION = "aws-us-east-2";
const BOX = /[┌┐└┘├┤┬┴┼─│]/;

const inspectRow = (fields: readonly string[]): Record<string, unknown> =>
	Object.fromEntries(fields.map((field) => [field, field]));

const headerOf = (out: string): string =>
	stripAnsi(out).trimEnd().split("\n")[0] ?? "";

const titleCase = (field: string): string =>
	field
		.split("_")
		.map((word) => (word ? word[0]?.toUpperCase() + word.slice(1) : word))
		.join(" ");

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

describe("list field order", () => {
	it("puts Expires At before Created At on branches list", () => {
		const out = formatHumanChunk({
			data: [
				{
					name: "main",
					id: BRANCH_ID,
					current_state: "ready",
					created_at: TIMESTAMP,
					default: true,
				},
				{
					name: "test_branch",
					id: "br-sunny-branch-123456",
					current_state: "ready",
					created_at: TIMESTAMP,
					expires_at: "2022-01-01T00:00:00.000Z",
				},
			],
			fields: BRANCH_FIELDS,
			renderColumns: {
				expires_at: neverExpires.expires_at,
				name: branchName,
			},
			colorTitle: false,
		});
		const header = headerOf(out);
		expect(header.indexOf("Expires At")).toBeGreaterThan(-1);
		expect(header.indexOf("Expires At")).toBeLessThan(
			header.indexOf("Created At"),
		);
		expect(stripAnsi(out)).toMatch(/never/);
	});

	it("puts Expires At before Created At on snapshots list", () => {
		const out = formatHumanChunk({
			data: [
				{
					id: "snap-main-123456",
					name: "nightly",
					source_branch_id: BRANCH_ID,
					created_at: TIMESTAMP,
				},
				{
					id: "snap-two-123456",
					name: "adhoc",
					source_branch_id: BRANCH_ID,
					created_at: TIMESTAMP,
					expires_at: "2022-01-01T00:00:00.000Z",
				},
			],
			fields: SNAPSHOT_FIELDS,
			renderColumns: { expires_at: neverExpires.expires_at },
			colorTitle: false,
		});
		const header = headerOf(out);
		expect(header.indexOf("Expires At")).toBeGreaterThan(-1);
		expect(header.indexOf("Expires At")).toBeLessThan(
			header.indexOf("Created At"),
		);
	});

	it("puts Recoverable Until before Deleted At on projects list --recoverable-only", () => {
		const out = formatHumanChunk({
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
			fields: RECOVERABLE_PROJECT_FIELDS,
			colorTitle: false,
		});
		const header = headerOf(out);
		expect(header.indexOf("Recoverable Until")).toBeGreaterThan(-1);
		expect(header.indexOf("Recoverable Until")).toBeLessThan(
			header.indexOf("Deleted At"),
		);
		for (const field of PROJECT_FIELDS) {
			expect(header).toContain(titleCase(field));
		}
	});

	it("prints claim list as full-width columns without boxes", () => {
		const origin = "https://claimable.neon.tech";
		const out = formatHumanChunk({
			data: [
				{
					project_id: PROJECT_ID,
					branch_id: BRANCH_ID,
					expires_at: TIMESTAMP,
					origin,
				},
			],
			fields: CLAIM_LIST_FIELDS,
			width: 40,
			colorTitle: false,
		});
		expect(out).not.toMatch(BOX);
		const header = headerOf(out);
		for (const field of CLAIM_LIST_FIELDS) {
			expect(header).toContain(titleCase(field));
		}
		expect(header.indexOf("Expires At")).toBeGreaterThan(-1);
		expect(stripAnsi(out)).toContain(PROJECT_ID);
		expect(stripAnsi(out)).toContain(origin);
		expect(stripAnsi(out).trimEnd().split("\n")).toHaveLength(2);
	});
});

describe("inspect list columns", () => {
	const inspectLists: { command: string; fields: readonly string[] }[] = (
		Object.keys(INSPECT_QUERIES) as InspectSubcommand[]
	).flatMap((name) => {
		const query = INSPECT_QUERIES[name];
		const lists: { command: string; fields: readonly string[] }[] = [
			{ command: `inspect db ${name}`, fields: query.fields },
		];
		if (query.scope === "database") {
			lists.push({
				command: `inspect db ${name} (all databases)`,
				fields: ["database", ...query.fields],
			});
		}
		return lists;
	});

	it("covers every inspect query, including the all-databases field list", () => {
		const names = new Set(inspectLists.map((list) => list.command));
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

	it.each(inspectLists)("$command shows every declared field", (list) => {
		const out = formatHumanChunk({
			data: [inspectRow(list.fields)],
			fields: list.fields,
			width: 40,
			colorTitle: false,
		});
		expect(out).not.toMatch(BOX);
		const header = headerOf(out);
		for (const field of list.fields) {
			expect(header).toContain(titleCase(field));
		}
		expect(stripAnsi(out).trimEnd().split("\n")).toHaveLength(2);
	});
});
