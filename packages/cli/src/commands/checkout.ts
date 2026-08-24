import type { Branch } from "@neon/sdk";
import chalk from "chalk";
import prompts from "prompts";
import type yargs from "yargs";
import { isNeonApiError } from "../api.js";

import { applyContext, contextBranch, readContextFile } from "../context.js";
import { isCi } from "../env.js";
import { log } from "../log.js";
import type { AgentBranchOption, CommonProps } from "../types.js";
import {
	createBranch,
	pickBranchInteractively,
} from "../utils/branch_picker.js";
import { getCliName } from "../utils/cli_name.js";
import { fillSingleProject } from "../utils/enrichers.js";
import { looksLikeBranchId } from "../utils/formats.js";
import {
	applyPolicyOnCreate,
	createBranchFromPolicyOnCheckout,
} from "./config.js";
import { autoPullEnvAfterPin } from "./env.js";
import { handler as linkHandler } from "./link.js";

type CheckoutProps = CommonProps & {
	projectId?: string;
	orgId?: string;
	id?: string;
	envPull: boolean;
	/** Emit a JSON state-machine response for agents instead of prompting. */
	agent?: boolean;
	/** Global `--color` flag (default true); `--no-color` sets it false to force plain output. */
	color?: boolean;
};

// The positional is optional: omitting it in an interactive terminal opens a
// branch picker. In non-interactive contexts a missing branch is an error.
export const command = "checkout [id|name]";
export const describe =
	"Pin a branch in the local context (.neon) so subsequent commands target it";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 checkout [id|name] [options]")
		.positional("id", {
			describe:
				"Branch name or id to check out. Omit to pick interactively from the list of branches.",
			type: "string",
		})
		.options({
			"project-id": {
				describe: "Project ID",
				type: "string",
			},
			"env-pull": {
				describe:
					"Pull the branch's Neon env vars (DATABASE_URL, …) into a local .env after " +
					"checkout. On by default; use --no-env-pull to skip (e.g. when injecting env at " +
					"runtime with `neon-env run` / `neon dev`).",
				type: "boolean",
				default: true,
			},
			agent: {
				describe:
					"Emit a JSON state-machine response designed for AI agents instead of " +
					"prompting. With no branch, returns a `needs_branch` response listing the " +
					"branches to choose from; with a branch, pins it, pulls env, and returns " +
					"`checked_out`.",
				type: "boolean",
				default: false,
			},
		})
		.example([
			[
				"$0 checkout",
				"Pick a branch interactively from the project in the closest .neon file",
			],
			[
				"$0 checkout main",
				'Pin the branch named "main" in the closest .neon file',
			],
			[
				"$0 checkout br-cool-snow-12345678 --project-id project-id-123",
				"Pin a branch by id for an explicit project",
			],
		]);

export const handler = async (props: CheckoutProps) => {
	// Agent mode: emit a JSON state-machine response instead of the human flow
	// (prompts/log lines). Kept as an early return so the interactive path below
	// is untouched.
	if (props.agent) {
		await runCheckoutAgent(props);
		return;
	}

	// Show where the context is pinned *before* we switch it, so the user sees the move
	// ("currently on X" → "checked out Y") and can catch a checkout they didn't mean to make.
	// Read straight from `.neon` (a name, no API call); silent when nothing is pinned yet.
	const previousBranch = contextBranch(readContextFile(props.contextFile));
	if (previousBranch) {
		log.info(
			"%s Currently on branch %s",
			chalk.dim("→"),
			chalk.cyan.bold(previousBranch),
		);
	}

	// Branch listing is project-scoped, so `projectId` is the only thing
	// `checkout` actually needs. Resolve it through the standard chain
	// (--project-id flag > .neon file > single-project auto-detect); when
	// nothing resolves, fall back to an interactive `neonctl link`.
	const projectId = await resolveProjectId(props);

	const { branchId, branchName, created, policyApplied, policyFailure } =
		await resolveBranchId(props, projectId);

	const orgId = await resolveOrgId(props, projectId);

	// `checkout` is a thin helper over `link`. It fully "heals" the context file:
	// it always (re)writes `projectId`, `branch`, and `orgId` (when the project
	// has one) so a `.neon` that drifted or was missing fields ends up complete
	// and consistent after checkout. The branch is stored as its name when known
	// (see `link`'s `branch` field), matching what `link` writes.
	applyContext(props.contextFile, {
		projectId,
		...(orgId ? { orgId } : {}),
		branch: branchName,
	});

	log.info(
		"Checked out branch %s on project %s%s. Updated %s.",
		branchId,
		projectId,
		orgId ? ` (org ${orgId})` : "",
		props.contextFile,
	);

	// When checkout *created* the branch and a neon.ts exists, the branch was created straight
	// from the policy (evaluated as a new branch) so its settings/infra are already applied —
	// see `policyApplied`. The fallback below covers the case where the branch was created bare
	// (e.g. a policy-driven create wasn't possible); `applyPolicyOnCreate` is a no-op when there
	// is no neon.ts on disk. Checking out an existing branch never reconciles it.
	const failure =
		created && !policyApplied
			? await applyPolicyOrDescribeFailure({
					projectId,
					branchId,
					...(props.apiKey ? { apiKey: props.apiKey } : {}),
					...(props.apiHost ? { apiHost: props.apiHost } : {}),
					...(props.color !== undefined
						? { color: props.color }
						: {}),
				})
			: policyFailure;

	// Bundle `env pull` so the branch-first loop is just link + checkout: the branch you
	// checked out is immediately usable for local dev. `--no-env-pull` opts out.
	await autoPullEnvAfterPin({
		...props,
		projectId,
		branch: branchId,
		envPull: props.envPull,
	});

	// A policy that didn't fully apply is reported last, after the pin and the env pull, so the
	// created branch is left in a consistent, usable, re-runnable state: the failure is what
	// needs fixing, not the checkout. Still a non-zero exit — the branch does not match the
	// policy, and `checkout` will not reconcile it on a second run.
	if (failure) {
		throw new Error(
			[
				`Branch ${branchName} (${branchId}) was created and checked out, but applying neon.ts to it failed: ${failure}`,
				`The branch is usable but does not match the policy, and \`${getCliName()} checkout\` never reconciles a branch that already exists.`,
				`Fix the cause above, then run \`${getCliName()} deploy --update-existing\` to apply the policy to it — or, if your policy only configures new branches (keyed on \`!branch.exists\`), delete the branch and check it out again: \`${getCliName()} branches delete ${branchName}\` then \`${getCliName()} checkout ${branchName}\`.`,
			].join("\n"),
		);
	}
};

// ----------------------------------------------------------------------------
// Agent mode (JSON state machine) — mirrors `link --agent`'s contract so an
// agent walking the link → checkout flow sees one consistent shape.
// ----------------------------------------------------------------------------

type CheckoutAgentResponse =
	| {
			status: "needs_branch";
			instruction: string;
			options: AgentBranchOption[];
			// Mirrors `link --agent`'s needs_branch shape so an agent sees one contract.
			context: { orgId?: string; projectId: string };
			next_command_template: string;
	  }
	| {
			status: "checked_out";
			context_file: string;
			context: { orgId?: string; projectId: string; branch: string };
			// The branch is pinned; `env_pull` reports whether env actually landed on
			// disk. A "failed"/"empty" pull is NOT a clean success — the branch is
			// checked out but DATABASE_URL may be absent, so an agent must check this.
			env_pull: "written" | "empty" | "skipped" | "failed";
			env_file?: string;
			pulled?: string[];
			message: string;
	  }
	| { status: "error"; code: string; message: string };

const emitCheckoutAgent = (response: CheckoutAgentResponse) => {
	process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
};

// Quote a value for a copy-pasteable `next_command_template`, matching how
// `link` and `bootstrap` build theirs. Project ids are already shell-safe, but
// keeping the same helper keeps the three commands' templates consistent.
const shellArg = (value: string): string => {
	if (/^[A-Za-z0-9._:/-]+$/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
};

/**
 * Agent-mode checkout. Resolves the project, then:
 *  - no branch arg + >1 branch  → `needs_branch` (list + next_command_template)
 *  - no branch arg + 1 branch   → pin it, pull env, `checked_out`
 *  - branch arg that exists     → pin it, pull env, `checked_out`
 *  - branch arg not found       → `needs_branch` (never silently create; branch
 *                                 creation is stateful and needs explicit confirmation)
 * Never prompts. Errors are emitted as `{ status: "error" }` with exit 1.
 */
const runCheckoutAgent = async (props: CheckoutProps): Promise<void> => {
	try {
		const projectId = await resolveProjectId(props);
		const branches = (
			await props.apiClient.listProjectBranches({ projectId })
		).data.branches;

		// A project always has a default branch; an empty list means a transient
		// API issue, so surface it as an error rather than an empty needs_branch.
		if (branches.length === 0) {
			emitCheckoutAgent({
				status: "error",
				code: "NO_BRANCHES",
				message: `Project ${projectId} returned no branches.`,
			});
			process.exitCode = 1;
			return;
		}

		const options: AgentBranchOption[] = branches.map((b: Branch) => ({
			id: b.id,
			name: b.name ?? b.id,
			default: Boolean(b.default),
		}));

		// The next command an agent runs (checkout again with a branch). Thread the
		// ids we already hold so it's self-contained; --org-id only when it was
		// passed (checkout resolves the org from --project-id, so it's optional).
		const nextTemplate =
			`${getCliName()} checkout <branch> --agent --project-id ${shellArg(projectId)}` +
			(props.orgId ? ` --org-id ${shellArg(props.orgId)}` : "");

		// Resolve which branch to pin, or emit needs_branch and stop.
		let target: Branch | undefined;
		if (props.id) {
			const ref = props.id;
			target = looksLikeBranchId(ref)
				? branches.find((b: Branch) => b.id === ref)
				: branches.find((b: Branch) => b.name === ref);
			if (!target) {
				emitCheckoutAgent({
					status: "needs_branch",
					instruction: `Branch "${ref}" was not found in this project. Ask the user which existing branch to check out, then re-run the next_command_template with it. This never creates a branch.`,
					options,
					context: { projectId },
					next_command_template: nextTemplate,
				});
				return;
			}
		} else if (branches.length === 1) {
			target = branches[0];
		} else {
			emitCheckoutAgent({
				status: "needs_branch",
				instruction:
					"Ask the user which branch to check out, then re-run the next_command_template with the chosen branch name.",
				options,
				context: { projectId },
				next_command_template: nextTemplate,
			});
			return;
		}

		// `target` is set on every path that reaches here (the branches-empty and
		// not-found/needs-branch cases returned above); this narrows the type.
		if (!target) return;

		const branchName = target.name ?? target.id;
		const orgId = await resolveOrgId(props, projectId);

		applyContext(props.contextFile, {
			projectId,
			...(orgId ? { orgId } : {}),
			branch: branchName,
		});

		const pull = await autoPullEnvAfterPin({
			...props,
			projectId,
			branch: target.id,
			envPull: props.envPull,
		});

		emitCheckoutAgent({
			status: "checked_out",
			context_file: props.contextFile,
			context: {
				...(orgId ? { orgId } : {}),
				projectId,
				branch: branchName,
			},
			env_pull: pull.status,
			...(pull.status === "written"
				? { env_file: pull.file, pulled: pull.written }
				: {}),
			message:
				pull.status === "written"
					? `Checked out ${branchName} and pulled ${pull.written.length} Neon env var${pull.written.length === 1 ? "" : "s"} into ${pull.file}.`
					: pull.status === "failed"
						? `Checked out ${branchName}, but pulling env vars failed (${pull.message}). DATABASE_URL is not on disk; resolve the cause and run \`${getCliName()} env pull\`.`
						: pull.status === "skipped"
							? `Checked out ${branchName}. Env pull was skipped (--no-env-pull); no vars written.`
							: `Checked out ${branchName}. No Neon env vars to pull for this branch yet.`,
		});
	} catch (err) {
		emitCheckoutAgent({
			status: "error",
			code: isNeonApiError(err) ? "API_ERROR" : "INTERNAL_ERROR",
			message: err instanceof Error ? err.message : String(err),
		});
		process.exitCode = 1;
	}
};

/**
 * Apply the policy to a branch `checkout` just created bare, returning the failure message
 * instead of throwing it. The branch and the context pin already stand at this point, so a
 * failed apply must not abort the rest of the checkout — the handler reports it at the end.
 */
const applyPolicyOrDescribeFailure = async (
	props: Parameters<typeof applyPolicyOnCreate>[0],
): Promise<string | undefined> => {
	try {
		await applyPolicyOnCreate(props);
		return undefined;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
};

/**
 * Resolve the branch id to check out.
 *
 * - Branch **id** (`br-…`): looked up by id. A non-existent id is a hard "not
 *   found" error — we never offer to create one, since ids are server-assigned.
 * - Branch **name**: looked up by name. If it doesn't exist, in an interactive
 *   terminal we offer to create it (like `neonctl branch create --name <name>`);
 *   in a non-interactive context it's the usual "not found" error.
 * - **Omitted**: open an interactive picker listing the project's branches plus a
 *   "create a new branch" option (TTY only); in a non-interactive context a missing
 *   branch is a hard error.
 */
type ResolvedBranch = {
	branchId: string;
	/** Value to persist in `.neon` (the branch name when known, else its id). */
	branchName: string;
	/** True only when this checkout created a new branch (vs. selecting an existing one). */
	created: boolean;
	/**
	 * True when the branch was created through the local `neon.ts` policy, so the handler must
	 * not apply the policy a second time — whether or not every declared setting landed (see
	 * `policyFailure`). False for an existing branch or a bare create with no policy on disk.
	 */
	policyApplied: boolean;
	/**
	 * Why the policy did not fully apply to a branch this checkout created. The branch exists
	 * (so it still gets pinned), but its settings diverge from `neon.ts` — the handler reports
	 * this at the end with the remediation.
	 */
	policyFailure?: string;
};

const resolveBranchId = async (
	props: CheckoutProps,
	projectId: string,
): Promise<ResolvedBranch> => {
	const branches = (await props.apiClient.listProjectBranches({ projectId }))
		.data.branches;

	if (!props.id) {
		const picked = await pickBranchInteractively(branches, {
			message: "Which branch would you like to check out?",
			nonInteractiveMessage:
				`No branch specified. Pass a branch name or id (e.g. \`${getCliName()} checkout main\`), ` +
				"or run interactively to pick one from a list.",
		});
		if (picked.kind === "existing") {
			const existing = branches.find(
				(b: Branch) => b.id === picked.branchId,
			);
			return {
				branchId: picked.branchId,
				branchName: existing?.name ?? picked.branchId,
				created: false,
				policyApplied: false,
			};
		}
		// The user chose "create a new branch" from the picker.
		return createCheckoutBranch(props, projectId, picked.name, branches);
	}

	const ref = props.id;

	// A `br-…` value is an id; match strictly by id and never offer to create.
	if (looksLikeBranchId(ref)) {
		const byId = branches.find((b: Branch) => b.id === ref);
		if (byId) {
			return {
				branchId: byId.id,
				branchName: byId.name ?? byId.id,
				created: false,
				policyApplied: false,
			};
		}
		throw new Error(notFoundMessage(ref, branches));
	}

	const byName = branches.find((b: Branch) => b.name === ref);
	if (byName) {
		return {
			branchId: byName.id,
			branchName: byName.name ?? byName.id,
			created: false,
			policyApplied: false,
		};
	}

	// Name not found: offer to create it interactively, mirroring `branch create`.
	if (isCi() || !process.stdout.isTTY) {
		throw new Error(notFoundMessage(ref, branches));
	}

	log.error(notFoundMessage(ref, branches));
	const { create } = await prompts({
		type: "confirm",
		name: "create",
		message: `Branch "${ref}" does not exist. Create it now?`,
		initial: true,
	});
	if (!create) {
		throw new Error(
			`Aborted: branch "${ref}" was not found and not created.`,
		);
	}
	return createCheckoutBranch(props, projectId, ref, branches);
};

/**
 * Create the branch to check out. When a `neon.ts` exists, route through the policy-driven
 * create so the new branch comes up branched from the policy's `parent` and configured with
 * its declared TTL / compute / services (evaluated as a *new* branch). Otherwise fall back to
 * a bare branch off the default — the handler then applies the policy (a no-op with no
 * `neon.ts`).
 */
const createCheckoutBranch = async (
	props: CheckoutProps,
	projectId: string,
	name: string,
	branches: Branch[],
): Promise<ResolvedBranch> => {
	const fromPolicy = await createBranchFromPolicyOnCheckout({
		projectId,
		branchName: name,
		...(props.apiKey ? { apiKey: props.apiKey } : {}),
		...(props.apiHost ? { apiHost: props.apiHost } : {}),
		...(props.color !== undefined ? { color: props.color } : {}),
	});
	if (fromPolicy) {
		return {
			branchId: fromPolicy.branchId,
			branchName: name,
			created: true,
			policyApplied: true,
			...(fromPolicy.policyFailure
				? { policyFailure: fromPolicy.policyFailure }
				: {}),
		};
	}
	return {
		branchId: await createBranch(
			props.apiClient,
			projectId,
			name,
			branches,
		),
		branchName: name,
		created: true,
		policyApplied: false,
	};
};

const notFoundMessage = (ref: string, branches: Branch[]): string =>
	`Branch ${ref} not found.\nAvailable branches: ${branches
		.map((b: Branch) => b.name)
		.join(", ")}`;

/**
 * Resolve the org id to heal into the context file.
 *
 * Prefer an org id we already know (from `--org-id`, the `.neon` file, or a
 * freshly-run `link`). Otherwise look it up from the project itself so the
 * `.neon` file ends up with an accurate `orgId` even when it was previously
 * missing. Projects on a personal account have no org; in that case (or if the
 * lookup fails for a non-auth reason) we return `undefined` and simply omit the
 * field rather than failing the checkout.
 */
const resolveOrgId = async (
	props: CheckoutProps,
	projectId: string,
): Promise<string | undefined> => {
	if (props.orgId) {
		return props.orgId;
	}
	try {
		const { data } = await props.apiClient.getProject(projectId);
		return data.project.org_id ?? undefined;
	} catch (err) {
		if (isNeonApiError(err) && err.status === 401) {
			throw err;
		}
		log.debug(
			"checkout: could not resolve org id for project %s: %s",
			projectId,
			err instanceof Error ? err.message : String(err),
		);
		return undefined;
	}
};

/**
 * Resolve the project id `checkout` should target.
 *
 * `props.projectId` is already populated from the `--project-id` flag or the
 * closest `.neon` file (via the global `enrichFromContext` middleware). When
 * it's still missing we try to auto-detect a single project (same behaviour as
 * `branches` / `connection-string`). If that fails we surface a telling error
 * and, in an interactive terminal, offer to run `neonctl link` in the current
 * folder so the user can pick a project/branch without having to re-run the
 * command by hand.
 */
const resolveProjectId = async (props: CheckoutProps): Promise<string> => {
	if (props.projectId) {
		return props.projectId;
	}

	const autoDetected = await tryAutoDetectProject(props);
	if (autoDetected) {
		return autoDetected;
	}

	const missingProjectMessage =
		"Could not determine which Neon project to check out a branch from. " +
		"Provide one via the --project-id flag " +
		`or a .neon file (created by \`${getCliName()} link\` / \`${getCliName()} set-context\`).`;

	// Agent mode must never prompt: the caller reads JSON off stdout, so throw
	// (the runCheckoutAgent catch turns it into a `{ status: "error" }` response)
	// rather than blocking on a confirm it can't answer.
	if (props.agent || isCi() || !process.stdout.isTTY) {
		throw new Error(missingProjectMessage);
	}

	log.error(missingProjectMessage);

	const { runLink } = await prompts({
		type: "confirm",
		name: "runLink",
		message: `Run \`${getCliName()} link\` in the current folder to pick a project now?`,
		initial: true,
	});

	if (!runLink) {
		throw new Error(
			"Aborted: no project selected. Re-run with --project-id or link a project first.",
		);
	}

	await linkHandler({
		...props,
		agent: false,
		yes: false,
		clear: false,
		checks: true,
	});

	const linked = readContextFile(props.contextFile);
	if (!linked.projectId) {
		throw new Error(
			`Linking did not produce a project id. Re-run \`${getCliName()} checkout\` once the directory is linked.`,
		);
	}
	// Carry the freshly-linked org id forward so the merge below keeps it.
	if (linked.orgId) {
		props.orgId = linked.orgId;
	}
	return linked.projectId;
};

/**
 * Best-effort single-project auto-detection. Returns the project id when the
 * API key maps to exactly one project, or `undefined` when the project can't be
 * determined unambiguously (zero or multiple projects) so the caller can fall
 * back to the interactive `link` flow.
 */
const tryAutoDetectProject = async (
	props: CheckoutProps,
): Promise<string | undefined> => {
	try {
		const filled = await fillSingleProject(props);
		return filled.projectId;
	} catch (err) {
		// `fillSingleProject` throws on "No projects found" / "Multiple projects
		// found" — both mean we can't pick a project automatically. Network/auth
		// errors are real and should surface to the user.
		if (isNeonApiError(err)) {
			throw err;
		}
		log.debug(
			"checkout: could not auto-detect a single project: %s",
			err instanceof Error ? err.message : String(err),
		);
		return undefined;
	}
};
