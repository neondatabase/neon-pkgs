import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import prompts from "prompts";
import type yargs from "yargs";

import {
	CONTEXT_FILE,
	contextBranch,
	gitBranchMap,
	gitBranchMapping,
	isUnfollowedGitHookSync,
	readContextFile,
	setGitBranchMap,
	setGitBranchMapping,
	setGitFollow,
} from "../context.js";
import { isCi } from "../env.js";
import { log } from "../log.js";
import type { CommonProps } from "../types.js";
import { neonSafeBranchName } from "../utils/branch_name.js";
import {
	currentGitBranch,
	GIT_HOOK_ENV_FLAG,
	gitPull,
	gitRepoRoot,
	hasUpstream,
	installPostCheckoutHook,
	isGitRepo,
	isManagedHook,
	localGitBranches,
	postCheckoutHookPath,
	readGitContext,
	removePostCheckoutHook,
} from "../utils/git.js";
import { handler as checkoutHandler } from "./checkout.js";
import { quoteFlagValue } from "./link.js";

type GitProps = CommonProps & {
	projectId?: string;
	orgId?: string;
	envPull?: boolean;
	quiet?: boolean;
	/** Tri-state: `--pull` (true), `--no-pull` (false), or unset (prompt in a manual TTY). */
	pull?: boolean;
	/** `git cleanup`: also delete the orphaned Neon branches (never default/protected). */
	pruneNeonBranches?: boolean;
	/** `git cleanup`: skip the deletion confirmation prompt. */
	yes?: boolean;
};

export const command = "git";
export const describe =
	"Sync the checked-out Neon branch to your git branch (Preview)";
export const aliases: string[] = [];

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 git <sub-command> [options]")
		.command(
			"install",
			"Install a git post-checkout hook that syncs the Neon branch on `git checkout`",
			(yargs) => yargs,
			(args) => {
				install(args as unknown as GitProps);
			},
		)
		.command(
			"uninstall",
			"Remove the git post-checkout hook installed by `git install`",
			(yargs) => yargs,
			(args) => {
				uninstall(args as unknown as GitProps);
			},
		)
		.command(
			"sync",
			"Check out the Neon branch mapped to the current git branch (run by the hook)",
			(yargs) =>
				yargs.options({
					"env-pull": {
						describe:
							"Pull the branch's Neon env vars into a local .env after sync. On by default.",
						type: "boolean",
						default: true,
					},
					pull: {
						describe:
							"Run `git pull --ff-only` before syncing so local files (incl. migration " +
							"files) match the branch before any checkout.after migration runs. Without " +
							"the flag, prompts when run manually in a TTY and skips in the hook / CI.",
						type: "boolean",
					},
					quiet: {
						describe: "Reduce output (used by the git hook).",
						type: "boolean",
						default: false,
					},
				}),
			(args) => sync(args as unknown as GitProps),
		)
		.command(
			"status",
			"Show the git context, hook state, and current git → Neon mapping",
			(yargs) => yargs,
			(args) => {
				status(args as unknown as GitProps);
			},
		)
		.command(
			"cleanup",
			"Prune git → Neon mappings whose local git branch is gone; optionally delete the orphaned Neon branches",
			(yargs) =>
				yargs.options({
					"prune-neon-branches": {
						describe:
							"Also delete the orphaned Neon branches (never the default or a protected branch).",
						type: "boolean",
						default: false,
					},
					yes: {
						describe:
							"Skip the confirmation prompt before deleting Neon branches.",
						type: "boolean",
						default: false,
					},
				}),
			(args) => cleanup(args as unknown as GitProps),
		);

export const handler = (args: yargs.Argv) => args;

const requireRepoRoot = (): string => {
	const cwd = process.cwd();
	if (!isGitRepo(cwd)) {
		throw new Error(
			"Not inside a git repository. Run `neon git` from a git work tree.",
		);
	}
	const repoRoot = gitRepoRoot(cwd);
	if (!repoRoot) {
		throw new Error("Could not resolve the git repository root.");
	}
	return repoRoot;
};

/**
 * `.neon` at exactly the repo root — never walk-up-resolved. The single source of truth for
 * all git-hooks state: `git.follow` and the git → Neon map. A `post-checkout` hook always
 * runs with `cwd` at the repo root, so every function here (`install`, `uninstall`, `sync`,
 * `status`, `cleanup`) reads and writes this exact path, never `props.contextFile`'s
 * walk-up resolution — an ancestor directory's unrelated `.neon` (e.g. a parent monorepo
 * folder) must never be mistaken for this repo's own state.
 *
 * Deliberately never *creates* this file: `install` requires it to already exist (from a
 * prior `neon link` / `neon checkout` run at the repo root), and `sync` skips persisting a
 * mapping when it's absent. Auto-creating a bare `{ git: {...} }` file with no `projectId`
 * would plant a **new**, closer `.neon` that shadows a real project link recorded in an
 * ancestor directory (or a linked subdirectory) for every other command's normal
 * context resolution — silently breaking `checkout` / `deploy` / `status` in that
 * directory. Requiring the link first also keeps this file and the project context file
 * the same file whenever hooks state exists, which is what makes `cleanup`'s project-match
 * check (see below) actually correct.
 */
const repoRootContextFile = (repoRoot: string): string =>
	join(repoRoot, CONTEXT_FILE);

export const install = (_props: GitProps): void => {
	const repoRoot = requireRepoRoot();

	const gitStateFile = repoRootContextFile(repoRoot);
	// A real `projectId` — not just file presence (`{}` is a valid on-disk state, e.g. after
	// `neon link --clear`) — since the whole feature is meaningless without a linked project.
	if (!readContextFile(gitStateFile).projectId) {
		const quoted = quoteFlagValue(gitStateFile);
		throw new Error(
			`No project linked at the repository root (${gitStateFile}).\n` +
				`Run \`neon link --context-file ${quoted}\` (an explicit path, since a plain ` +
				"`neon link` walks up and may update a different, ancestor `.neon` instead) " +
				`or \`neon checkout <branch> --context-file ${quoted}\` first, then re-run ` +
				"`neon git install`.",
		);
	}

	const result = installPostCheckoutHook(repoRoot);
	if (result.status === "conflict") {
		throw new Error(
			`A non-neon \`post-checkout\` hook already exists at ${result.hookPath}.\n` +
				"Remove or rename it first, then re-run `neon git install`.",
		);
	}
	setGitFollow(gitStateFile, true);
	log.info(
		"Git → Neon sync %s. `git checkout <branch>` will now check out the mapped Neon branch.\n" +
			"Hook: %s",
		result.status === "installed" ? "installed" : "updated",
		postCheckoutHookPath(repoRoot),
	);
};

export const uninstall = (_props: GitProps): void => {
	const repoRoot = requireRepoRoot();

	const result = removePostCheckoutHook(repoRoot);
	const gitStateFile = repoRootContextFile(repoRoot);
	// Only clear `follow` in a file that already exists — never create one (see
	// `repoRootContextFile`'s doc comment for why that would be its own bug).
	if (existsSync(gitStateFile)) {
		setGitFollow(gitStateFile, false);
	}
	switch (result) {
		case "removed":
			log.info(
				"Removed the neon git post-checkout hook. Git → Neon sync is off.",
			);
			break;
		case "foreign":
			log.warning(
				"Left the existing `post-checkout` hook in place (not managed by neon). " +
					"Git → Neon sync flag cleared.",
			);
			break;
		case "absent":
			log.info(
				"No neon git hook was installed. Git → Neon sync flag cleared.",
			);
			break;
	}
};

/**
 * Check out the Neon branch that corresponds to the current git branch. Invoked by the
 * installed `post-checkout` hook (with `NEON_GIT_HOOK=1`) and runnable by hand. Resolves the
 * Neon branch name via the persisted map (sticky), delegates to `neon checkout` (whose
 * `checkout.before` hook may further map the name and whose `checkout.after` hook runs
 * migrations, etc.), then records the resulting git → Neon mapping so it stays stable.
 */
export const sync = async (props: GitProps): Promise<void> => {
	// See `isUnfollowedGitHookSync`'s doc comment for why this is checked (and mirrored in
	// the global auth middleware, ahead of authentication) before anything else — no git
	// check, no API call, nothing. A manual `neon git sync` (no hook env flag) is
	// unaffected: it's an explicit ask, run it regardless of `follow`.
	if (isUnfollowedGitHookSync({ _: ["git", "sync"] })) {
		log.debug(
			"Skipping git sync: this repo has not run `neon git install` (git.follow is not set).",
		);
		return;
	}

	const cwd = process.cwd();
	if (!isGitRepo(cwd)) {
		throw new Error("Not inside a git repository.");
	}
	const repoRoot = gitRepoRoot(cwd) ?? cwd;
	const gitStateFile = repoRootContextFile(repoRoot);

	const context = readContextFile(gitStateFile);
	const gitBranch = currentGitBranch(cwd);
	if (!gitBranch) {
		log.info("Detached HEAD — no git branch to sync. Skipping.");
		return;
	}

	// Optionally fast-forward local files (incl. committed migration files) before checkout, so
	// a shared branch that is ahead of your local tree doesn't leave code↔schema skewed when the
	// `checkout.after` migration runs. Opt-in (network + can diverge); see resolveShouldPull.
	if (await resolveShouldPull(props, cwd, gitBranch)) {
		const outcome = gitPull(cwd);
		switch (outcome.status) {
			case "pulled":
				log.info(
					"%s git pull --ff-only (%s)",
					chalk.dim("→"),
					gitBranch,
				);
				break;
			case "no-upstream":
				log.info("No upstream for %s — skipping git pull.", gitBranch);
				break;
			case "failed":
				log.warning(
					"git pull --ff-only failed (continuing with sync): %s",
					outcome.detail,
				);
				break;
		}
	}

	// Resolve the Neon branch name to check out:
	//   1. a previously-recorded mapping wins (sticky — no duplicate branches), else
	//   2. a Neon-safe name derived from the git branch (see `neonSafeBranchName`).
	// (2) means a brand-new branch is always valid by default — no `checkout.before` hook
	// required. A `checkout.before` hook can still override: it receives the git branch on
	// `event.gitBranch` / `git.neonSafeBranchName`, so it can re-derive with its own prefix
	// and stay stable.
	const inputName =
		gitBranchMapping(context, gitBranch) ?? neonSafeBranchName(gitBranch);

	await checkoutHandler({
		...props,
		id: inputName,
		envPull: props.envPull ?? true,
	});

	// Persist the mapping from the branch actually pinned, so subsequent checkouts of this git
	// branch resolve to the same Neon branch without re-deriving. `checkoutHandler` pins the
	// branch into `props.contextFile`, which is normally the SAME file as `gitStateFile` (the
	// repo-root walk-up finds it immediately) — in which case re-reading the root here (AFTER
	// checkout, not the `context` read further above) picks up the `projectId` checkout just
	// wrote, even starting from an empty `{}` root. An explicit `--context-file` /
	// `--project-id` can instead point checkout at a different project; that's the case this
	// guards against recording into the root's map, which `cleanup` would then treat as if it
	// belonged to the root's own project regardless of which project it actually came from.
	const rootProjectId = readContextFile(gitStateFile).projectId;
	const pinnedContext = readContextFile(props.contextFile);
	if (!rootProjectId || pinnedContext.projectId !== rootProjectId) {
		log.warning(
			"Not persisting the git → Neon mapping: this checkout targeted project %s, not " +
				"a project linked at the repo root (%s).",
			pinnedContext.projectId ?? "(unknown)",
			rootProjectId ?? "none",
		);
	} else {
		const resolved = contextBranch(pinnedContext);
		if (resolved) {
			setGitBranchMapping(gitStateFile, gitBranch, resolved);
		}
	}
};

/**
 * Decide whether `git sync` should `git pull` first. Mirrors the rest of the CLI's
 * auto-vs-interactive philosophy (cf. `checkout` / `link`): an explicit flag always wins;
 * otherwise we only *prompt* in a real manual TTY, and never auto-pull in the post-checkout
 * hook or CI (no network surprises in automation). Skips when there's nothing upstream.
 */
const resolveShouldPull = async (
	props: GitProps,
	cwd: string,
	gitBranch: string,
): Promise<boolean> => {
	if (props.pull === true) return true;
	if (props.pull === false) return false;
	if (!hasUpstream(cwd)) return false;
	const triggeredByGitHook = process.env[GIT_HOOK_ENV_FLAG] === "1";
	if (triggeredByGitHook || isCi() || !process.stdout.isTTY) return false;
	const { pull } = await prompts({
		type: "confirm",
		name: "pull",
		message: `Pull latest for "${gitBranch}" (git pull --ff-only) before syncing?`,
		initial: false,
	});
	return Boolean(pull);
};

export const status = (_props: GitProps): void => {
	const cwd = process.cwd();
	const git = readGitContext(cwd);
	if (!git.available) {
		log.info("Not inside a git repository.");
		return;
	}

	const repoRoot = git.repoRoot ?? cwd;
	const hookPath = postCheckoutHookPath(repoRoot);
	const installed = isManagedHook(hookPath);
	const context = readContextFile(repoRootContextFile(repoRoot));
	const mapping = context.git?.map ?? {};
	const currentBranch = git.branch;
	const mappedNeon = currentBranch
		? gitBranchMapping(context, currentBranch)
		: undefined;

	log.info(
		"Git branch:        %s",
		chalk.cyan(currentBranch ?? "(detached)"),
	);
	log.info("Hook installed:    %s", installed ? chalk.green("yes") : "no");
	log.info(
		"Follow on checkout: %s",
		context.git?.follow ? chalk.green("yes") : "no",
	);
	if (currentBranch) {
		log.info(
			"Maps to Neon:      %s",
			mappedNeon
				? chalk.cyan(mappedNeon)
				: chalk.dim("(unmapped — will derive on next sync)"),
		);
	}
	const entries = Object.entries(mapping);
	if (entries.length > 0) {
		log.info("Known mappings:");
		for (const [g, n] of entries) {
			log.info("  %s → %s", g, n);
		}
	}
};

/** A Neon branch as far as pruning cares (the live list returns more). */
type PrunableBranch = {
	id: string;
	name: string;
	default?: boolean;
	protected?: boolean;
};

/**
 * Split the orphaned Neon branches (those mapped from now-deleted git branches) into the ones
 * safe to delete and the ones to skip. Default and protected branches are **never** deleted.
 * Pure (no I/O) so it's unit-testable.
 */
export const partitionBranchesToPrune = <B extends PrunableBranch>(
	branches: B[],
	orphanNeonNames: ReadonlySet<string>,
): { toDelete: B[]; skipped: { name: string; reason: string }[] } => {
	const toDelete: B[] = [];
	const skipped: { name: string; reason: string }[] = [];
	for (const branch of branches) {
		if (!orphanNeonNames.has(branch.name)) continue;
		if (branch.default) {
			skipped.push({ name: branch.name, reason: "default branch" });
		} else if (branch.protected) {
			skipped.push({ name: branch.name, reason: "protected" });
		} else {
			toDelete.push(branch);
		}
	}
	return { toDelete, skipped };
};

/**
 * Prune the git → Neon workflow state. By default this only cleans `.neon`: mapping entries
 * whose git branch no longer exists locally are dropped. With `--prune-neon-branches` it also
 * deletes the orphaned Neon branches — never the default branch and never a protected one.
 */
export const cleanup = async (props: GitProps): Promise<void> => {
	const cwd = process.cwd();
	if (!isGitRepo(cwd)) {
		throw new Error("Not inside a git repository.");
	}
	const repoRoot = gitRepoRoot(cwd) ?? cwd;
	const gitStateFile = repoRootContextFile(repoRoot);

	const context = readContextFile(gitStateFile);
	const map = gitBranchMap(context);
	const entries = Object.entries(map);
	if (entries.length === 0) {
		log.info("No git → Neon mappings to clean up.");
		return;
	}

	const local = new Set(localGitBranches(cwd));
	const stale = entries.filter(([gitBranch]) => !local.has(gitBranch));
	if (stale.length === 0) {
		log.info(
			"All %d mapping(s) still have a local git branch — nothing to prune.",
			entries.length,
		);
		return;
	}

	const kept = Object.fromEntries(
		entries.filter(([gitBranch]) => local.has(gitBranch)),
	);
	// A Neon branch name still referenced by a kept mapping (two git branches sharing one
	// target, e.g. via `checkout.before` or name sanitization) is never orphaned — even
	// though the *other* mapping to it went stale. That stale mapping is still safe to drop
	// right away: the Neon branch it pointed at isn't going anywhere.
	const keptNeonNames = new Set(Object.values(kept));
	const staleButShared = stale.filter(([, neonBranch]) =>
		keptNeonNames.has(neonBranch),
	);
	const orphaned = stale.filter(
		([, neonBranch]) => !keptNeonNames.has(neonBranch),
	);

	if (!props.pruneNeonBranches) {
		// Mapping-only mode: nothing Neon-side is being touched this run, so pruning every
		// stale mapping now — shared-target or not — is final and safe either way.
		setGitBranchMap(gitStateFile, kept);
		log.info("Pruned %d stale mapping(s) from .neon:", stale.length);
		for (const [gitBranch, neonBranch] of stale) {
			log.info("  %s → %s", gitBranch, neonBranch);
		}
		if (orphaned.length > 0) {
			log.info(
				"Run `neon git cleanup --prune-neon-branches` (before this mapping-only cleanup) " +
					"to also delete the now-orphaned Neon branch(es): %s.",
				orphaned.map(([, neonBranch]) => neonBranch).join(", "),
			);
		}
		return;
	}

	// `--prune-neon-branches`: a stale mapping whose target Neon branch is a genuine
	// deletion candidate (`orphaned`) stays on disk until that branch is actually deleted
	// (or excluded as default/protected), so a declined confirmation or a failed delete
	// leaves it intact for a later retry. A stale mapping whose target is still shared with
	// a kept mapping (`staleButShared`) is pruned immediately — nothing about it depends on
	// the deletion outcome below.
	if (staleButShared.length > 0) {
		setGitBranchMap(gitStateFile, {
			...kept,
			...Object.fromEntries(orphaned),
		});
		log.info(
			"Pruned %d stale mapping(s) whose Neon branch is still in use elsewhere:",
			staleButShared.length,
		);
		for (const [gitBranch, neonBranch] of staleButShared) {
			log.info("  %s → %s", gitBranch, neonBranch);
		}
	}

	if (!props.projectId) {
		throw new Error(
			"Cannot delete Neon branches: no project in context. Run `neon link` first.",
		);
	}

	// The map was recorded against `context.projectId` (the project `.neon` is actually
	// linked to) — required, not just checked when present: `sync` never writes a mapping
	// without also confirming/recording the root's `projectId` (see `sync`'s own guard), so
	// a map entry with no root `projectId` is not a state our own code produces, and must
	// not be trusted to belong to whatever project happens to be active. `props.projectId`
	// can differ from a genuine root link — an explicit `--project-id` override, or a stale
	// enrichment — and resolving names against a *different* project than the one the
	// mapping was built for could match and delete an unrelated same-named branch there.
	if (!context.projectId) {
		throw new Error(
			"Cannot delete Neon branches: the git → Neon map has no recorded project (the " +
				`repo-root .neon at ${gitStateFile} has no projectId). Run ` +
				`\`neon link --context-file ${quoteFlagValue(gitStateFile)}\` to establish it, ` +
				"or `neon git cleanup` with no --prune-neon-branches to only prune the local " +
				"mapping.",
		);
	}
	if (context.projectId !== props.projectId) {
		throw new Error(
			"Cannot delete Neon branches: this git → Neon map was recorded against project " +
				`${context.projectId}, but the active project is ${props.projectId}. Run ` +
				`\`neon link\` (or drop --project-id) to target ${context.projectId}, or ` +
				"`neon git cleanup` with no --prune-neon-branches to only prune the local mapping.",
		);
	}

	if (orphaned.length === 0) {
		log.info("No orphaned Neon branches to delete.");
		return;
	}

	const orphanNeonNames = new Set(
		orphaned.map(([, neonBranch]) => neonBranch),
	);
	const branches = (
		await props.apiClient.listProjectBranches({
			projectId: props.projectId,
		})
	).data.branches;
	const { toDelete, skipped } = partitionBranchesToPrune(
		branches,
		orphanNeonNames,
	);

	for (const { name, reason } of skipped) {
		log.warning(
			"Keeping Neon branch %s (%s) — never auto-deleted.",
			name,
			reason,
		);
	}

	if (toDelete.length === 0) {
		log.info("No orphaned Neon branches to delete.");
		return;
	}

	if (!(await confirmPrune(props, toDelete))) {
		log.info(
			"Aborted — no Neon branches were deleted, and no mappings were pruned.",
		);
		return;
	}

	// Start from EVERY surviving mapping — `kept` plus the full `orphaned` set, including
	// the ones about to be attempted. A branch's mapping is dropped from `currentMap` and
	// written to disk (every iteration, success or failure) only once ITS OWN delete call
	// succeeds — never before, never batched to the end — so an interruption can lose
	// neither an already-completed deletion's mapping-removal nor a still-pending one's
	// mapping. A lost mapping couldn't be recovered anyway (a later name-based re-match
	// risks matching an unrelated branch that reused the name).
	const currentMap = { ...kept, ...Object.fromEntries(orphaned) };

	const failed: { name: string; error: string }[] = [];
	let prunedCount = 0;
	for (const branch of toDelete) {
		const branchMappings = orphaned.filter(
			([, neonBranch]) => neonBranch === branch.name,
		);
		try {
			await props.apiClient.deleteProjectBranch(
				props.projectId,
				branch.id,
			);
			log.info("Deleted Neon branch %s (%s).", branch.name, branch.id);
			prunedCount += branchMappings.length;
			for (const [gitBranch, neonBranch] of branchMappings) {
				log.info("  Pruned %s → %s", gitBranch, neonBranch);
				delete currentMap[gitBranch];
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.error(
				"Failed to delete Neon branch %s: %s",
				branch.name,
				message,
			);
			failed.push({ name: branch.name, error: message });
			// This branch's mapping(s) are already in `currentMap` from the initial
			// assignment above — nothing to do; the branch itself is still there.
		}
		setGitBranchMap(gitStateFile, currentMap);
	}

	if (prunedCount > 0) {
		log.info("Pruned %d stale mapping(s) from .neon.", prunedCount);
	}

	if (failed.length > 0) {
		throw new Error(
			`Failed to delete ${failed.length} Neon branch(es): ${failed
				.map((f) => `${f.name} (${f.error})`)
				.join(
					", ",
				)}. Re-run \`neon git cleanup --prune-neon-branches\` to retry.`,
		);
	}
};

/**
 * Confirm deleting the orphaned Neon branches. Deletion is destructive, so an explicit
 * `--yes` wins; otherwise prompt in an interactive terminal, and refuse (with a warning) in
 * CI / non-interactive contexts rather than deleting without consent.
 */
const confirmPrune = async (
	props: GitProps,
	toDelete: PrunableBranch[],
): Promise<boolean> => {
	if (props.yes) return true;
	if (isCi() || !process.stdout.isTTY) {
		log.warning(
			"Refusing to delete %d Neon branch(es) non-interactively. Re-run with --yes to confirm.",
			toDelete.length,
		);
		return false;
	}
	const { ok } = await prompts({
		type: "confirm",
		name: "ok",
		message: `Delete ${toDelete.length} orphaned Neon branch(es): ${toDelete
			.map((branch) => branch.name)
			.join(", ")}?`,
		initial: false,
	});
	return Boolean(ok);
};
