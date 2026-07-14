import type { Branch } from "@neon/sdk";
import chalk from "chalk";
import type yargs from "yargs";

import { isNeonApiError } from "../api.js";
import { log } from "../log.js";
import type { CommonProps } from "../types.js";
import { fillSingleProject } from "../utils/enrichers.js";
import { looksLikeBranchId } from "../utils/formats.js";
import {
	type DatabaseSchemaDiff,
	renderDatabaseSchemaDiff,
	renderSchemaDiffReport,
} from "../utils/git_diff.js";
import { writer } from "../writer.js";

type DiffProps = CommonProps & {
	projectId: string;
	/** The branch under review (the `+++` side). Filled from `.neon` when omitted. */
	branch?: string;
	/** The branch to compare against (the `---` side). The `compare-branch` positional. */
	compareBranch?: string;
	database?: string;
	color: boolean;
};

/** A branch resolved to both its id and a friendly name for the diff header. */
type BranchRef = { branchId: string; branchName: string };

// A top-level shortcut for `branches schema-diff`, framed like `git diff`: it
// compares the branch you're on (pinned in `.neon`, or `--branch`) against the
// branch you name, and prints a git-style unified schema diff. Because it has a
// handler but no subcommands, `diff` is also listed in `NO_SUBCOMMANDS_VERBS`
// (see index.ts) so a bare `neon diff main` isn't intercepted by the help
// fallback.
export const command = "diff [compare-branch]";
export const describe =
	"Show a git-style schema diff between the current branch and another branch";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 diff [compare-branch] [options]")
		.positional("compare-branch", {
			describe:
				"Branch name or id to compare against (the reference / '---' side). " +
				"Defaults to the current branch's parent.",
			type: "string",
		})
		.options({
			"project-id": {
				describe: "Project ID",
				type: "string",
			},
			branch: {
				alias: "b",
				describe:
					"The branch to review (the '+++' side). Defaults to the branch " +
					"pinned in the local context (.neon).",
				type: "string",
			},
			database: {
				alias: "db",
				describe:
					"Limit the diff to a single database. Defaults to every database on the current branch.",
				type: "string",
			},
		})
		.middleware(fillSingleProject as never)
		.middleware((args: yargs.Arguments) => {
			// The positional arrives as `compare-branch`; surface it under the
			// camelCase name the handler reads, and mirror it to `branchId` for
			// analytics (same pattern as the `branches` command group).
			const compareBranch = args["compare-branch"];
			if (typeof compareBranch === "string") {
				args.compareBranch = compareBranch;
			}
		})
		.example([
			[
				"$0 diff main",
				"Diff the current branch's schema against the main branch",
			],
			[
				"$0 diff",
				"Diff the current branch's schema against its parent branch",
			],
			[
				"$0 diff main --branch feature/checkout",
				"Diff an explicit branch against main (ignoring the .neon context)",
			],
			[
				"$0 diff main --db neondb",
				"Diff only the neondb database against main",
			],
		]);

export const handler = async (props: DiffProps) => {
	const branches = (
		await props.apiClient.listProjectBranches({
			projectId: props.projectId,
		})
	).data.branches;

	const after = resolveAfterBranch(branches, props.branch);
	const before = resolveBeforeBranch(branches, after, props.compareBranch);

	if (before.branchId === after.branchId) {
		throw new Error(
			`Nothing to compare: both sides resolve to branch ${after.branchName} (${after.branchId}).`,
		);
	}

	const databases = await resolveDatabases(props, after);

	const diffs: DatabaseSchemaDiff[] = [];
	for (const database of databases) {
		const [beforeSql, afterSql] = await Promise.all([
			fetchSchemaSql(props, before.branchId, database),
			fetchSchemaSql(props, after.branchId, database),
		]);
		diffs.push({
			database,
			before: { ...before, sql: beforeSql },
			after: { ...after, sql: afterSql },
		});
	}

	if (props.output === "json" || props.output === "yaml") {
		writeStructured(props, diffs);
		return;
	}

	log.info(
		"%s Comparing schema %s → %s",
		chalk.dim("→"),
		chalk.red(`${before.branchName}`),
		chalk.green(`${after.branchName}`),
	);

	const { hasChanges, text } = renderSchemaDiffReport(diffs, {
		color: props.color !== false,
	});

	if (!hasChanges) {
		log.info(
			"No schema differences between %s and %s.",
			before.branchName,
			after.branchName,
		);
		return;
	}

	writer(props).text(`${text}\n`);
};

/**
 * Resolve the branch under review (`+++` side). Prefers the explicit
 * `branch`/`--branch` value (name or `br-…` id), falling back to the project's
 * default branch. An unknown `br-…` id is trusted as-is (it may be too new to
 * appear in the listing); an unknown *name* is a hard error.
 */
const resolveAfterBranch = (
	branches: Branch[],
	ref: string | undefined,
): BranchRef => {
	if (ref) {
		return resolveRef(branches, ref);
	}
	const def = branches.find((b) => b.default);
	if (!def) {
		throw new Error(
			"No branch specified and no default branch found. Pass --branch <name|id>.",
		);
	}
	return { branchId: def.id, branchName: def.name ?? def.id };
};

/**
 * Resolve the reference branch (`---` side). Uses the `compare-branch`
 * positional when given, otherwise the parent of the branch under review — so a
 * bare `neon diff` answers "what did I change since branching?".
 */
const resolveBeforeBranch = (
	branches: Branch[],
	after: BranchRef,
	ref: string | undefined,
): BranchRef => {
	if (ref) {
		return resolveRef(branches, ref);
	}
	const afterBranch = branches.find((b) => b.id === after.branchId);
	const parentId = afterBranch?.parent_id;
	if (!parentId) {
		throw new Error(
			`Branch "${after.branchName}" has no parent to compare against. ` +
				"Pass a branch to compare with, e.g. `neon diff main`.",
		);
	}
	const parent = branches.find((b) => b.id === parentId);
	return {
		branchId: parentId,
		branchName: parent?.name ?? parentId,
	};
};

/** Resolve a branch reference (name or `br-…` id) against the fetched listing. */
const resolveRef = (branches: Branch[], ref: string): BranchRef => {
	const found = looksLikeBranchId(ref)
		? branches.find((b) => b.id === ref)
		: branches.find((b) => b.name === ref);
	if (found) {
		return { branchId: found.id, branchName: found.name ?? found.id };
	}
	// A `br-…` id absent from the listing is still usable as an id; only an
	// unresolved name is a genuine error (mirrors resolveBranchRef in enrichers).
	if (looksLikeBranchId(ref)) {
		return { branchId: ref, branchName: ref };
	}
	throw new Error(
		`Branch ${ref} not found.\nAvailable branches: ${branches
			.map((b) => b.name)
			.join(", ")}`,
	);
};

/**
 * The databases to diff: the one passed via `--database` (validated against the
 * branch under review), or every database on that branch when none is given.
 */
const resolveDatabases = async (
	props: DiffProps,
	after: BranchRef,
): Promise<string[]> => {
	const databases = (
		await props.apiClient.listProjectBranchDatabases(
			props.projectId,
			after.branchId,
		)
	).data.databases;

	if (props.database !== undefined) {
		if (!databases.find((d) => d.name === props.database)) {
			throw new Error(
				`Database "${props.database}" not found on branch ${after.branchName}. ` +
					`Available: ${databases.map((d) => d.name).join(", ")}`,
			);
		}
		return [props.database];
	}

	if (databases.length === 0) {
		throw new Error(
			`No databases found on branch ${after.branchName} (${after.branchId}).`,
		);
	}
	return databases.map((d) => d.name);
};

/**
 * Fetch a branch database's `CREATE …` SQL. A database absent from the branch
 * (404) yields an empty schema, so the diff shows it as fully added/removed
 * rather than failing — the natural outcome when a database exists on only one
 * side of the comparison.
 */
const fetchSchemaSql = async (
	props: DiffProps,
	branchId: string,
	database: string,
): Promise<string> => {
	try {
		const { data } = await props.apiClient.getProjectBranchSchema({
			projectId: props.projectId,
			branchId,
			db_name: database,
		});
		return data.sql ?? "";
	} catch (err) {
		if (isNeonApiError(err) && err.status === 404) {
			log.debug(
				"diff: database %s not found on branch %s; treating schema as empty",
				database,
				branchId,
			);
			return "";
		}
		throw err;
	}
};

/** Machine-readable output for `--output json|yaml`: one entry per database. */
const writeStructured = (props: DiffProps, diffs: DatabaseSchemaDiff[]) => {
	const report = diffs.map((diff) => {
		const rendered = renderDatabaseSchemaDiff(diff, { color: false });
		return {
			database: diff.database,
			base_branch: diff.before.branchName,
			base_branch_id: diff.before.branchId,
			compare_branch: diff.after.branchName,
			compare_branch_id: diff.after.branchId,
			has_changes: rendered.hasChanges,
			diff: rendered.text,
		};
	});
	writer(props).end(report, {
		fields: [
			"database",
			"base_branch",
			"compare_branch",
			"has_changes",
			"diff",
		],
	});
};
