import { findProjectContext } from "./context.js";
import { MissingContextError } from "./errors.js";

/**
 * A branch reference: either a Neon-issued id (e.g. `br-cool-snow-12345`) or a
 * human-readable branch name. We disambiguate solely on the `br-` prefix.
 */
export type BranchRef =
	| { kind: "id"; value: string }
	| { kind: "name"; value: string };

/**
 * Options accepted by {@link loadContext}.
 */
export interface LoadContextOptions {
	/**
	 * Explicit branch id or name. Takes precedence over `NEON_BRANCH_ID` and the context
	 * file. Values starting with `br-` are treated as ids; everything else is treated as
	 * a name.
	 */
	branch?: string;
	/** Explicit project id. Takes precedence over `NEON_PROJECT_ID` and the context file. */
	projectId?: string;
	/** Explicit org id. Takes precedence over `NEON_ORG_ID` and the context file. */
	orgId?: string;
	/** Starting directory for the project-context file search. Defaults to `process.cwd()`. */
	cwd?: string;
}

/**
 * Fully-resolved Neon context combining all three sources (call args, env, file).
 */
export interface NeonContext {
	projectId: string;
	orgId?: string;
	branch?: BranchRef;
	/** Absolute path of the context file that was read, if any. */
	sourcePath?: string;
}

/**
 * Resolve the Neon project and (optionally) branch context this process should target.
 *
 * Resolution chain — each entry wins over the next:
 *
 * | Field      | 1st (call args)         | 2nd (env)           | 3rd (file)                  |
 * | ---------- | ----------------------- | ------------------- | --------------------------- |
 * | branch     | `options.branch`        | `NEON_BRANCH_ID`    | `branchId` in `.neon[/project.json]` |
 * | projectId  | `options.projectId`     | `NEON_PROJECT_ID`   | `projectId` in `.neon[/project.json]` |
 * | orgId      | `options.orgId`         | `NEON_ORG_ID`       | `orgId` in `.neon[/project.json]`     |
 *
 * Throws {@link MissingContextError} when no project id can be resolved from any source.
 * Per the package's read-only-filesystem contract, this function never creates files.
 */
export function loadContext(options: LoadContextOptions = {}): NeonContext {
	const file = findProjectContext({ cwd: options.cwd });

	const projectId =
		nonEmptyString(options.projectId) ??
		nonEmptyString(process.env.NEON_PROJECT_ID) ??
		file?.projectId;

	if (!projectId) {
		throw new MissingContextError(
			[
				"No Neon project id could be resolved.",
				"loadContext checked three sources in order: (1) `options.projectId`, (2) the `NEON_PROJECT_ID` environment variable, and (3) the `projectId` field of `.neon/project.json` (or the neonctl `.neon` file) above the current directory.",
				"Set any one of these to continue. For an interactive bootstrap, run `npx neonctl set-context --project-id <id>`.",
			].join(" "),
		);
	}

	const orgId =
		nonEmptyString(options.orgId) ??
		nonEmptyString(process.env.NEON_ORG_ID) ??
		file?.orgId;

	const branchRaw =
		nonEmptyString(options.branch) ??
		nonEmptyString(process.env.NEON_BRANCH_ID) ??
		file?.branchId;

	const ctx: NeonContext = { projectId };
	if (orgId) ctx.orgId = orgId;
	if (file?.sourcePath) ctx.sourcePath = file.sourcePath;
	if (branchRaw) ctx.branch = classifyBranchRef(branchRaw);
	return ctx;
}

/**
 * Like {@link loadContext} but throws {@link MissingContextError} when no branch was
 * resolved. Convenience for branch-targeted operations.
 */
export function loadContextWithBranch(
	options: LoadContextOptions = {},
): NeonContext & {
	branch: BranchRef;
} {
	const ctx = loadContext(options);
	if (!ctx.branch) {
		throw new MissingContextError(
			[
				"No Neon branch id or name could be resolved.",
				"loadContextWithBranch checked three sources in order: (1) `options.branch`, (2) the `NEON_BRANCH_ID` environment variable, and (3) the `branchId` field of `.neon/project.json` (or the neonctl `.neon` file).",
				"Set any one of these to continue.",
			].join(" "),
		);
	}
	return { ...ctx, branch: ctx.branch };
}

function classifyBranchRef(value: string): BranchRef {
	if (/^br-[a-z0-9-]+$/i.test(value)) {
		return { kind: "id", value };
	}
	return { kind: "name", value };
}

function nonEmptyString(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}
