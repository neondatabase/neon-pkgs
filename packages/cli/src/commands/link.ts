import type {
	Branch,
	Organization,
	ProjectCreateRequest,
	ProjectListItem,
	RegionResponse,
} from "@neon/sdk";
import prompts, { type InitialReturnValue } from "prompts";
import type yargs from "yargs";
import { isNeonApiError, messageFromBody } from "../api.js";

import {
	applyContext,
	type Context,
	contextBranch,
	readContextFile,
	setContext,
	updateContextFile,
} from "../context.js";
import { isCi } from "../env.js";
import { log } from "../log.js";
import type { CommonProps } from "../types.js";
import {
	createBranch,
	pickBranchInteractively,
} from "../utils/branch_picker.js";
import { getCliName } from "../utils/cli_name.js";
import { helpEpilogue } from "../utils/help_text.js";
import { hasNeonConfigFile, initCmd } from "./config.js";
import { autoPullEnvAfterPin } from "./env.js";
import { REGIONS } from "./projects.js";

const PROJECTS_LIST_LIMIT = 100;

const CREATE_NEW_SENTINEL = "__create_new__";

type LinkProps = CommonProps & {
	orgId?: string;
	projectId?: string;
	projectName?: string;
	regionId?: string;
	branch?: string;
	params?: string;
	agent?: boolean;
	yes: boolean;
	clear: boolean;
	checks: boolean;
	envPull: boolean;
};

type Inputs = {
	orgId?: string;
	projectId?: string;
	projectName?: string;
	regionId?: string;
	/** Branch name or ID as supplied by the user; resolved to an ID before persisting. */
	branch?: string;
};

const canPromptInteractively = (): boolean =>
	!isCi() && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

const nonInteractiveLinkCommands = (): string[] => {
	const cli = getCliName();
	return [
		`${cli} orgs list --output json`,
		`${cli} projects list --org-id <org-id> --output json`,
		`${cli} link --project-id <project-id>`,
		`${cli} link --org-id <org-id> --project-name <name> --region-id aws-us-east-2`,
	];
};

const nonInteractiveLinkHelp = (): string =>
	nonInteractiveLinkCommands()
		.map((command) => `  ${command}`)
		.join("\n");

const orgScopedKeyHint =
	"Organization-scoped API keys cannot list orgs; pass --org-id.";

const removedAgent = (): string =>
	`\`${getCliName()} link --agent\` was removed.\nUse:\n${nonInteractiveLinkHelp()}\n${orgScopedKeyHint}`;

export const command = "link";
export const describe = "Link the current directory to a Neon project";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 link [options]")
		.options({
			"org-id": {
				describe: "Organization ID to link to",
				type: "string",
			},
			"project-id": {
				describe: "Existing project ID to link to",
				type: "string",
			},
			"project-name": {
				describe: "Name for a new project to create and link to",
				type: "string",
			},
			"region-id": {
				describe:
					"Region ID for a new project (e.g. aws-us-east-2). Required with --project-name.",
				type: "string",
			},
			branch: {
				alias: "branch-id",
				describe:
					"Branch name or ID to pin in the context (resolved to its ID before writing). " +
					"Without it, link only resolves the org and project — pin a branch with " +
					`\`${getCliName()} checkout <branch>\` (link never guesses a default).`,
				type: "string",
			},
			params: {
				describe:
					'JSON object with link parameters, e.g. \'{"orgId":"...","projectId":"..."}\' or \'{"orgId":"...","projectName":"...","regionId":"..."}\'. Flags take precedence over fields in --params.',
				type: "string",
			},
			agent: {
				hidden: true,
				type: "boolean",
			},
			yes: {
				alias: "y",
				describe:
					'Skip the "already linked" confirmation in interactive mode and re-link anyway.',
				type: "boolean",
				default: false,
			},
			clear: {
				describe:
					"Remove the org/project/branch context (writes an empty context file) instead of linking.",
				type: "boolean",
				default: false,
			},
			checks: {
				describe:
					"Verify the org/project/branch exist (and resolve the org from the project) before " +
					"writing. On by default; use --no-checks to write the context offline with no API " +
					"calls — it then requires --org-id and --project-id (--branch optional) and skips " +
					"env pull.",
				type: "boolean",
				default: true,
			},
			"env-pull": {
				describe:
					"Pull the linked branch's Neon env vars (DATABASE_URL, …) into a local .env after " +
					"linking. On by default; use --no-env-pull to skip (e.g. when injecting env at " +
					"runtime with `neon-env run` / `neon dev`). Only runs when a branch is pinned.",
				type: "boolean",
				default: true,
			},
		})
		.example([
			[
				"$0 link --project-id polished-snowflake-12345678",
				`Link an existing project (org is inferred); pin a branch later with '${getCliName()} checkout'`,
			],
			[
				"$0 link --org-id org-… --project-name my-app --region-id aws-us-east-2",
				"Create a new project and link it",
			],
			[
				"$0 link --branch-id br-…",
				"Pin a branch in the already-linked project",
			],
			[
				"$0 link --no-checks --org-id org-… --project-id polished-snowflake-12345678",
				"Write the context offline (no API calls, no verification)",
			],
			[
				"$0 link --clear",
				"Forget the current org/project/branch context",
			],
		])
		.epilogue(
			helpEpilogue(
				"Non-interactive (CI, scripts, agents):",
				...nonInteractiveLinkCommands().map(
					(command) => `  ${command}`,
				),
				orgScopedKeyHint,
			),
		)
		.check((argv) => {
			if (argv.agent === true) {
				throw new Error(removedAgent());
			}
			return true;
		});

export const handler = async (props: LinkProps) => {
	if (props.clear) {
		clearContext(props.contextFile);
		return;
	}

	if (!props.checks) {
		runWithoutChecks(props);
		return;
	}

	const inputs = parseInputs(props);
	validateInputs(inputs);
	const existing = readContextFile(props.contextFile);

	if (canResolveNonInteractively(inputs, existing)) {
		await runNonInteractive(props, inputs, existing);
		return;
	}

	if (!canPromptInteractively()) {
		log.error(
			[
				"Missing inputs and no interactive terminal for prompts.",
				"",
				"Use:",
				nonInteractiveLinkHelp(),
				orgScopedKeyHint,
			].join("\n"),
		);
		process.exit(1);
		return;
	}

	await runInteractive(props, inputs);
};

// ----------------------------------------------------------------------------
// Input parsing & validation
// ----------------------------------------------------------------------------

const parseInputs = (props: LinkProps): Inputs => {
	let fromParams: Inputs = {};
	if (props.params !== undefined && props.params !== "") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(props.params);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to parse --params JSON: ${message}`);
		}
		fromParams = extractParams(parsed);
	}
	return {
		orgId: props.orgId ?? fromParams.orgId,
		projectId: props.projectId ?? fromParams.projectId,
		projectName: props.projectName ?? fromParams.projectName,
		regionId: props.regionId ?? fromParams.regionId,
		branch: props.branch ?? fromParams.branch,
	};
};

const extractParams = (raw: unknown): Inputs => {
	if (raw === null || typeof raw !== "object") {
		throw new Error("--params must be a JSON object");
	}
	const obj = raw as Record<string, unknown>;
	const pickString = (key: string): string | undefined => {
		const value = obj[key];
		if (value === undefined || value === null) return undefined;
		if (typeof value !== "string") {
			throw new Error(`--params.${key} must be a string`);
		}
		return value;
	};
	return {
		orgId: pickString("orgId"),
		projectId: pickString("projectId"),
		projectName: pickString("projectName"),
		regionId: pickString("regionId"),
		branch: pickString("branch") ?? pickString("branchId"),
	};
};

const validateInputs = (inputs: Inputs): void => {
	if (inputs.projectId && (inputs.projectName || inputs.regionId)) {
		throw new Error(
			"Conflicting inputs: --project-id selects an existing project; --project-name and --region-id describe a new one. Pass only one set.",
		);
	}
	if (inputs.projectName && inputs.branch) {
		throw new Error(
			`Conflicting inputs: --branch pins a branch of an existing project, but --project-name creates a new one. Create the project first, then \`${getCliName()} checkout <branch>\`.`,
		);
	}
};

/**
 * Whether the inputs (combined with the existing `.neon`) fully determine what
 * to write without prompting the user. Everything else falls back to the
 * interactive picker (TTY) or the CI guard.
 *
 * - `--project-id` is always enough: the org is inferred from the project and
 *   the branch is left to an explicit `checkout` (never auto-defaulted).
 * - `--org-id --project-name --region-id` fully describes a project to create.
 * - `--branch-id` needs a project, which it takes from the existing `.neon`.
 * - `--org-id` on its own just records the default org (merged into any
 *   existing context).
 */
const canResolveNonInteractively = (
	inputs: Inputs,
	existing: Context,
): boolean => {
	if (inputs.projectId) return true;
	if (inputs.orgId && inputs.projectName && inputs.regionId) return true;
	if (inputs.branch && existing.projectId) return true;
	if (inputs.orgId && !inputs.projectName && !inputs.branch) return true;
	return false;
};

// ----------------------------------------------------------------------------
// Context helpers
// ----------------------------------------------------------------------------

const clearContext = (contextFile: string): void => {
	updateContextFile(contextFile, {});
	process.stdout.write(
		`Cleared ${contextFile}. The directory is no longer linked to a Neon org/project/branch.\n`,
	);
};

/**
 * `--no-checks`: write the context offline. Makes no API calls — so no org
 * inference, no existence/access verification, and no env pull — which means
 * the caller must supply both `--org-id` and `--project-id` (the org can't be
 * inferred without the network). `--branch` stays optional. This is the CLI
 * surface over {@link setContext}, useful for scripted/offline setups and for
 * re-creating a `.neon` from values you already trust.
 */
const runWithoutChecks = (props: LinkProps): void => {
	const inputs = parseInputs(props);
	validateInputs(inputs);
	if (inputs.projectName) {
		throw new Error(
			"--no-checks can't create a project (that needs API access). Pass --org-id and --project-id for an existing project, or drop --no-checks.",
		);
	}
	if (!inputs.orgId || !inputs.projectId) {
		throw new Error(
			"--no-checks writes the context with no API calls, so it needs both --org-id and --project-id (--branch is optional).",
		);
	}
	setContext(props.contextFile, {
		orgId: inputs.orgId,
		projectId: inputs.projectId,
		branch: inputs.branch,
	});
	printSummary(props, {
		contextFile: props.contextFile,
		orgId: inputs.orgId,
		projectId: inputs.projectId,
		branch: inputs.branch,
		created: false,
		noChecks: true,
	});
};

class LinkInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LinkInputError";
	}
}

const httpStatus = (err: unknown): number | undefined =>
	isNeonApiError(err) ? err.status : undefined;

/** 401 must reach the global handler so it can refresh credentials. */
const fetchProjectOrThrow = async (props: CommonProps, projectId: string) => {
	try {
		const { data } = await props.apiClient.getProject(projectId);
		return data.project;
	} catch (err) {
		const status = httpStatus(err);
		if (status === 401) {
			throw err;
		}
		if (status === 403) {
			throw new LinkInputError(
				`You don't have access to project '${projectId}'. Check that your API key's account or organization can see it.`,
			);
		}
		if (status === 404) {
			throw new LinkInputError(
				`Project '${projectId}' not found. Double-check the project ID — or that your API key has access to it.`,
			);
		}
		throw err;
	}
};

/**
 * Confirm the org exists and is reachable with the current API key by listing
 * its projects (allowed for both user and org-scoped keys). Maps 403/404 to a
 * clear message; 401 is rethrown for credential refresh.
 */
const verifyOrgAccess = async (
	props: CommonProps,
	orgId: string,
): Promise<void> => {
	try {
		await props.apiClient.listProjects({
			org_id: orgId,
			limit: PROJECTS_LIST_LIMIT,
		});
	} catch (err) {
		const status = httpStatus(err);
		if (status === 401) {
			throw err;
		}
		if (status === 403 || status === 404) {
			throw new LinkInputError(
				`Organization '${orgId}' not found, or your API key doesn't have access to it. Find your org ID in the Neon Console under Settings.`,
			);
		}
		throw err;
	}
};

/**
 * Resolve a branch reference (name *or* id) to the matching branch, while
 * confirming it actually exists in the project. Unlike the shared
 * `branchIdResolve`, this also verifies references that already look like ids
 * (so a typo'd `br-…` doesn't silently get written), and surfaces the available
 * branches when nothing matches so the user can correct it (or run `checkout`).
 */
const resolveBranchRef = async (
	props: CommonProps,
	projectId: string,
	branchRef: string,
): Promise<Branch> => {
	const { data } = await props.apiClient.listProjectBranches({ projectId });
	const match =
		data.branches.find((b: Branch) => b.id === branchRef) ??
		data.branches.find((b: Branch) => b.name === branchRef);
	if (match) {
		return match;
	}
	const available =
		data.branches.length > 0
			? data.branches
					.map(
						(b: Branch) => `${b.id}${b.name ? ` (${b.name})` : ""}`,
					)
					.join(", ")
			: "(none)";
	throw new LinkInputError(
		`Branch '${branchRef}' not found in project '${projectId}'. Available branches: ${available}. Pin one with \`${getCliName()} checkout <branch>\`.`,
	);
};

/**
 * The value to persist for a branch: prefer its human-readable **name** (nicer
 * to read in `.neon`, and still resolvable by every command), falling back to
 * the id when the branch has no name.
 */
const branchPersistValue = (branch: Branch): string => branch.name ?? branch.id;

/**
 * Verify the project (and the org, when supplied) and resolve the org id to
 * persist.
 *
 * The project is always fetched, which both validates it and yields its
 * `org_id`. When `--org-id` is passed too: if the project reports an org it must
 * match (else a clear mismatch error); if it reports none, the supplied org is
 * verified on its own. Without `--org-id` the project's own org is used, falling
 * back to the org already recorded for the *same* project in `.neon`. Projects
 * on a personal account have no org, so `undefined` is a valid result — the
 * field is simply omitted.
 */
const resolveOrgForProject = async (
	props: CommonProps,
	inputs: Inputs,
	existing: Context,
	projectId: string,
): Promise<string | undefined> => {
	const project = await fetchProjectOrThrow(props, projectId);
	const projectOrg = project.org_id ?? undefined;

	if (inputs.orgId) {
		if (projectOrg && projectOrg !== inputs.orgId) {
			throw new LinkInputError(
				`Project '${projectId}' belongs to organization '${projectOrg}', not '${inputs.orgId}'. Omit --org-id to use the project's own org, or pass the matching ID.`,
			);
		}
		if (!projectOrg) {
			await verifyOrgAccess(props, inputs.orgId);
		}
		return inputs.orgId;
	}

	if (projectOrg) {
		return projectOrg;
	}
	if (projectId === existing.projectId && existing.orgId) {
		return existing.orgId;
	}
	return undefined;
};

/**
 * Resolve the branch to persist alongside a project in non-interactive mode.
 *
 * `link` never guesses the project's default branch — that's `checkout`'s job —
 * so the only sources are an explicit `--branch` (name or id, verified and
 * normalized to its name) or a branch already pinned for the *same* project (so
 * re-linking it doesn't drop your checked-out branch). Reading the existing
 * branch via {@link contextBranch} also recovers a legacy `branchId` field.
 */
const resolvePinnedBranch = async (
	props: CommonProps,
	inputs: Inputs,
	existing: Context,
	projectId: string,
): Promise<string | undefined> => {
	if (inputs.branch) {
		const branch = await resolveBranchRef(props, projectId, inputs.branch);
		return branchPersistValue(branch);
	}
	if (projectId === existing.projectId) {
		return contextBranch(existing);
	}
	return undefined;
};

// ----------------------------------------------------------------------------
// Non-interactive flag-driven mode
// ----------------------------------------------------------------------------

const runNonInteractive = async (
	props: LinkProps,
	inputs: Inputs,
	existing: Context,
) => {
	// Create a new project and link it.
	if (inputs.projectName) {
		const orgId = mustString(inputs.orgId, "orgId");
		await verifyOrgAccess(props, orgId);
		const created = await createProject(props, {
			orgId,
			name: inputs.projectName,
			regionId: mustString(inputs.regionId, "regionId"),
		});
		applyContext(props.contextFile, {
			orgId,
			projectId: created.project.id,
			branch: created.branchName,
		});
		await finalizeLink(props, {
			contextFile: props.contextFile,
			orgId,
			projectId: created.project.id,
			branch: created.branchName,
			created: true,
			projectName: created.project.name,
			regionId: created.project.region_id,
		});
		return;
	}

	// Link an explicitly named existing project.
	if (inputs.projectId) {
		const orgId = await resolveOrgForProject(
			props,
			inputs,
			existing,
			inputs.projectId,
		);
		const branch = await resolvePinnedBranch(
			props,
			inputs,
			existing,
			inputs.projectId,
		);
		applyContext(props.contextFile, {
			orgId,
			projectId: inputs.projectId,
			branch,
		});
		await finalizeLink(props, {
			contextFile: props.contextFile,
			orgId,
			projectId: inputs.projectId,
			branch,
			created: false,
		});
		return;
	}

	// Pin a branch in the already-linked project.
	if (inputs.branch && existing.projectId) {
		const projectId = existing.projectId;
		const orgId = await resolveOrgForProject(
			props,
			inputs,
			existing,
			projectId,
		);
		const branch = await resolvePinnedBranch(
			props,
			inputs,
			existing,
			projectId,
		);
		applyContext(props.contextFile, {
			orgId,
			projectId,
			branch,
		});
		await finalizeLink(props, {
			contextFile: props.contextFile,
			orgId,
			projectId,
			branch,
			created: false,
		});
		return;
	}

	// Record the default org, preserving any existing project/branch.
	if (inputs.orgId) {
		const orgId = inputs.orgId;
		await verifyOrgAccess(props, orgId);
		const projectId = existing.projectId;
		const branch = projectId ? contextBranch(existing) : undefined;
		applyContext(props.contextFile, { orgId, projectId, branch });
		printSummary(props, {
			contextFile: props.contextFile,
			orgId,
			projectId,
			branch,
			created: false,
			orgOnly: true,
		});
		return;
	}
};

// ----------------------------------------------------------------------------
// Interactive mode (TTY)
// ----------------------------------------------------------------------------

const runInteractive = async (props: LinkProps, inputs: Inputs) => {
	if (!props.yes) {
		await confirmRelinkIfNeeded(props);
	}

	const orgResolution = await resolveOrg(props, inputs.orgId);
	let orgId: string;
	if (orgResolution.kind === "resolved") {
		orgId = orgResolution.orgId;
		if (orgResolution.autoDetected) {
			log.info(
				`Detected organization ${orgId} from your existing projects (organization-scoped API key).`,
			);
		}
	} else if (orgResolution.orgKeyLimited) {
		throw new Error(
			"This API key is organization-scoped, so the CLI cannot list your organizations, " +
				"and no existing project was found in this org to auto-detect the ID. " +
				"Re-run with `--org-id <your_org_id>` (find it in the Neon Console under Settings).",
		);
	} else {
		orgId = await promptOrgFromList(orgResolution.orgs);
	}

	if (inputs.projectName && inputs.regionId) {
		const created = await createProject(props, {
			orgId,
			name: inputs.projectName,
			regionId: inputs.regionId,
		});
		applyContext(props.contextFile, {
			orgId,
			projectId: created.project.id,
			branch: created.branchName,
		});
		await finalizeInteractiveLink(props, {
			contextFile: props.contextFile,
			orgId,
			projectId: created.project.id,
			branch: created.branchName,
			created: true,
			projectName: created.project.name,
			regionId: created.project.region_id,
		});
		return;
	}

	// Need to ask: existing project or create a new one?
	const projects = await listAllProjects(props, orgId);
	const action = await promptProjectChoice(projects, inputs.projectName);

	if (action.type === "existing") {
		const branch = await resolveInteractiveBranch(props, action.projectId);
		applyContext(props.contextFile, {
			orgId,
			projectId: action.projectId,
			branch,
		});
		await finalizeInteractiveLink(props, {
			contextFile: props.contextFile,
			orgId,
			projectId: action.projectId,
			branch,
			created: false,
			projectName: action.name,
			regionId: action.regionId,
		});
		return;
	}

	const projectName =
		inputs.projectName ?? (await promptProjectName(action.suggestedName));
	const regionId = inputs.regionId ?? (await promptRegion(props));
	const created = await createProject(props, {
		orgId,
		name: projectName,
		regionId,
	});
	applyContext(props.contextFile, {
		orgId,
		projectId: created.project.id,
		branch: created.branchName,
	});
	await finalizeInteractiveLink(props, {
		contextFile: props.contextFile,
		orgId,
		projectId: created.project.id,
		branch: created.branchName,
		created: true,
		projectName: created.project.name,
		regionId: created.project.region_id,
	});
};

const confirmRelinkIfNeeded = async (props: LinkProps): Promise<void> => {
	const existing = readContextFile(props.contextFile);
	if (!existing.orgId || !existing.projectId) {
		return;
	}
	const { proceed } = await prompts({
		onState: onPromptState,
		type: "confirm",
		name: "proceed",
		message: `${props.contextFile} is already linked to project ${existing.projectId} (org ${existing.orgId}). Re-link?`,
		initial: true,
	});
	if (!proceed) {
		process.stdout.write("Aborted. Existing link preserved.\n");
		process.exit(0);
	}
};

const promptOrgFromList = async (orgs: Organization[]): Promise<string> => {
	if (!orgs.length) {
		throw new Error(
			`You don't belong to any organizations. Create one in the Neon Console first: https://console.neon.tech/`,
		);
	}
	// A single organization leaves nothing to choose, so skip the prompt and link
	// it directly — go straight on to the project step.
	if (orgs.length === 1) {
		const [only] = orgs;
		log.info(`Linking organization ${only.name} (${only.id}).`);
		return only.id;
	}
	const { orgId } = await prompts({
		onState: onPromptState,
		type: "select",
		name: "orgId",
		message: "Which organization would you like to link?",
		choices: orgs.map((org) => ({
			title: `${org.name} (${org.id})`,
			value: org.id,
		})),
		initial: 0,
	});
	return orgId;
};

type ProjectChoice =
	| {
			type: "existing";
			projectId: string;
			name?: string;
			regionId?: string;
	  }
	| { type: "create"; suggestedName?: string };

const promptProjectChoice = async (
	projects: ProjectListItem[],
	suggestedName?: string,
): Promise<ProjectChoice> => {
	const choices = [
		{ title: "＋ Create new project…", value: CREATE_NEW_SENTINEL },
		...projects.map((project) => ({
			title: `${project.name} (${project.id})`,
			value: project.id,
		})),
	];
	// Create sits at the top, so default to the first existing project (index 1) when there
	// is one; with no projects to show, the create option (index 0) is the only choice.
	const { selection } = await prompts({
		onState: onPromptState,
		type: "select",
		name: "selection",
		message: "Which project would you like to link?",
		choices,
		initial: projects.length > 0 ? 1 : 0,
	});
	if (selection === CREATE_NEW_SENTINEL) {
		return { type: "create", suggestedName };
	}
	const project = projects.find((p) => p.id === selection);
	return {
		type: "existing",
		projectId: selection,
		name: project?.name,
		regionId: project?.region_id,
	};
};

const promptProjectName = async (
	suggestedName: string | undefined,
): Promise<string> => {
	const { name } = await prompts({
		onState: onPromptState,
		type: "text",
		name: "name",
		message: "Name for the new project:",
		initial: suggestedName,
		validate: (value: string) =>
			value && value.trim().length > 0
				? true
				: "Project name is required",
	});
	return String(name).trim();
};

const promptRegion = async (props: LinkProps): Promise<string> => {
	const regions = await fetchRegions(props);
	const defaultIndex = Math.max(
		0,
		regions.findIndex((r) => r.default),
	);
	const { regionId } = await prompts({
		onState: onPromptState,
		type: "select",
		name: "regionId",
		message: "Which region should the new project run in?",
		choices: regions.map((region) => ({
			title: `${region.name} (${region.region_id})`,
			value: region.region_id,
		})),
		initial: defaultIndex,
	});
	return regionId;
};

// ----------------------------------------------------------------------------
// API helpers
// ----------------------------------------------------------------------------

const ORG_KEY_LIMITED_FRAGMENT = "not allowed for organization API keys";

const isOrgKeyLimitedError = (err: unknown): boolean => {
	if (!isNeonApiError(err)) return false;
	const message = messageFromBody(err.data);
	return (
		typeof message === "string" &&
		message.includes(ORG_KEY_LIMITED_FRAGMENT)
	);
};

const fetchOrganizations = async (
	props: CommonProps,
): Promise<Organization[]> => {
	const { data } = await props.apiClient.getCurrentUserOrganizations();
	return data.organizations ?? [];
};

type OrgResolution =
	| { kind: "resolved"; orgId: string; autoDetected: boolean }
	| {
			kind: "needs_selection";
			orgs: Organization[];
			orgKeyLimited: boolean;
	  };

/**
 * Resolves the org id from the explicit flag, falling back to listing user orgs.
 *
 * For organization-scoped API keys, `getCurrentUserOrganizations` is forbidden;
 * in that case we try to auto-detect the org from the first existing project
 * (since all projects of an org key live in the same org). If no project exists
 * yet, we return `needs_selection` with `orgKeyLimited: true` so callers can
 * give a precise instruction to the user.
 */
const resolveOrg = async (
	props: CommonProps,
	given: string | undefined,
): Promise<OrgResolution> => {
	if (given) {
		return { kind: "resolved", orgId: given, autoDetected: false };
	}
	try {
		const orgs = await fetchOrganizations(props);
		return { kind: "needs_selection", orgs, orgKeyLimited: false };
	} catch (err) {
		if (!isOrgKeyLimitedError(err)) {
			throw err;
		}
		log.debug(
			"getCurrentUserOrganizations not allowed (org-scoped API key); attempting to derive org from existing projects.",
		);
	}
	const detected = await detectOrgIdFromProjects(props);
	if (detected) {
		return { kind: "resolved", orgId: detected, autoDetected: true };
	}
	return { kind: "needs_selection", orgs: [], orgKeyLimited: true };
};

const detectOrgIdFromProjects = async (
	props: CommonProps,
): Promise<string | undefined> => {
	try {
		const { data } = await props.apiClient.listProjects({ limit: 1 });
		return data.projects[0]?.org_id ?? undefined;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.debug("detectOrgIdFromProjects failed: %s", message);
		return undefined;
	}
};

const listAllProjects = async (
	props: CommonProps,
	orgId: string,
): Promise<ProjectListItem[]> => {
	const result: ProjectListItem[] = [];
	let cursor: string | undefined;
	while (true) {
		const { data } = await props.apiClient.listProjects({
			limit: PROJECTS_LIST_LIMIT,
			org_id: orgId,
			cursor,
		});
		result.push(...data.projects);
		cursor = data.pagination?.cursor;
		if (data.projects.length < PROJECTS_LIST_LIMIT) {
			break;
		}
	}
	return result;
};

/**
 * Resolve which branch to pin for an interactively-chosen project, returned as the value to
 * persist (its name when known, see {@link branchPersistValue}). When the project has a
 * single branch there is nothing to choose, so we pin it silently. Otherwise we offer the
 * shared branch picker (the same "＋ Create a new branch…" + list as `neonctl checkout`),
 * creating the branch when the user opts to. This makes interactive `link` a full org →
 * project → branch flow; non-interactive `link` instead defers the branch to `checkout`.
 */
const resolveInteractiveBranch = async (
	props: CommonProps,
	projectId: string,
): Promise<string> => {
	const { data } = await props.apiClient.listProjectBranches({ projectId });
	const branches = data.branches;
	if (branches.length <= 1) {
		const only = branches.find((b: Branch) => b.default) ?? branches[0];
		if (!only) {
			throw new Error(
				`Could not find a default branch for project ${projectId}.`,
			);
		}
		return branchPersistValue(only);
	}
	const picked = await pickBranchInteractively(branches, {
		message: "Which branch would you like to link?",
		nonInteractiveMessage:
			"No branch could be selected without an interactive terminal. " +
			`Re-run \`${getCliName()} link\` interactively, or \`${getCliName()} checkout <branch>\` to pin one.`,
	});
	if (picked.kind === "existing") {
		const existing = branches.find((b: Branch) => b.id === picked.branchId);
		return existing ? branchPersistValue(existing) : picked.branchId;
	}
	// A freshly-created branch: we already know the name the user typed.
	await createBranch(props.apiClient, projectId, picked.name, branches);
	return picked.name;
};

const fetchRegions = async (props: CommonProps): Promise<RegionResponse[]> => {
	try {
		const { data } = await props.apiClient.getActiveRegions();
		if (data.regions && data.regions.length > 0) {
			return data.regions;
		}
	} catch (err) {
		if (isNeonApiError(err)) {
			log.debug(
				"getActiveRegions failed (%s), falling back to the static region list.",
				err.status ?? err.code ?? err.message,
			);
		} else {
			const message = err instanceof Error ? err.message : String(err);
			log.debug(
				"getActiveRegions failed (%s), falling back to the static region list.",
				message,
			);
		}
	}
	return staticRegionsFallback();
};

const staticRegionsFallback = (): RegionResponse[] =>
	REGIONS.map((id) => ({
		region_id: id,
		name: id,
		default: id === "aws-us-east-2",
		geo_lat: "",
		geo_long: "",
	}));

type CreatedProject = {
	project: { id: string; name?: string; region_id?: string };
	branchId: string;
	/** Value to persist for the new project's sole branch (its name when present, else id). */
	branchName: string;
};

const createProject = async (
	props: CommonProps,
	args: { orgId: string; name: string; regionId: string },
): Promise<CreatedProject> => {
	const project: ProjectCreateRequest["project"] = {
		name: args.name,
		region_id: args.regionId,
		org_id: args.orgId,
		branch: {},
	};
	const { data } = await props.apiClient.createProject({ project });
	if (!data.branch?.id) {
		throw new Error(
			"Project was created but the API response did not include a default branch id.",
		);
	}
	return {
		project: {
			id: data.project.id,
			name: data.project.name,
			region_id: data.project.region_id,
		},
		branchId: data.branch.id,
		branchName: data.branch.name ?? data.branch.id,
	};
};

// ----------------------------------------------------------------------------
// Output helpers
// ----------------------------------------------------------------------------

type HumanSummary = {
	contextFile: string;
	orgId?: string;
	projectId?: string;
	branch?: string;
	created: boolean;
	projectName?: string;
	regionId?: string;
	/** True for the `--org-id`-only path: records the default org without nudging checkout. */
	orgOnly?: boolean;
	/** True for the `--no-checks` path: written offline, so suppress the checkout nudge. */
	noChecks?: boolean;
};

const printSummary = (_props: LinkProps, summary: HumanSummary): void => {
	const lines: string[] = [];
	if (summary.created) {
		lines.push(
			`Created project ${summary.projectId}${summary.projectName ? ` ("${summary.projectName}")` : ""}${summary.regionId ? ` in ${summary.regionId}` : ""}.`,
		);
	}
	lines.push(
		`${summary.orgOnly ? "Updated" : "Linked"} ${summary.contextFile}:`,
	);
	if (summary.orgId) {
		lines.push(`  orgId:     ${summary.orgId}`);
	}
	if (summary.projectId) {
		lines.push(`  projectId: ${summary.projectId}`);
	}
	if (summary.branch) {
		lines.push(`  branch:    ${summary.branch}`);
	}
	if (summary.noChecks) {
		lines.push("");
		lines.push("Written offline (--no-checks): nothing was verified.");
	} else if (summary.projectId && !summary.branch && !summary.orgOnly) {
		lines.push("");
		lines.push(
			`No branch pinned. Run \`${getCliName()} checkout <branch>\` to pin a branch and pull its env vars.`,
		);
	}
	lines.push("");
	process.stdout.write(`${lines.join("\n")}\n`);
};

/**
 * Print the link summary, then run the bundled `env pull` so a human `link` that pinned a
 * branch ends with the branch's connection string already on disk. When no branch was pinned
 * there is nothing to pull, so env pull is skipped and the summary nudges `checkout` instead.
 * `--no-env-pull` opts out (env pull's own status / skip hint is logged to stderr).
 */
const finalizeLink = async (
	props: LinkProps,
	summary: HumanSummary,
): Promise<void> => {
	printSummary(props, summary);
	if (!summary.branch || !summary.projectId) {
		return;
	}
	await autoPullEnvAfterPin({
		...props,
		projectId: summary.projectId,
		branch: summary.branch,
		envPull: props.envPull,
	});
};

/**
 * Interactive `link` finalize: the shared {@link finalizeLink} (summary + env
 * pull), then — as the last step — offer to manage the project's Neon setup as
 * code with a `neon.ts`. Kept out of {@link finalizeLink} so the non-interactive
 * paths never prompt.
 */
const finalizeInteractiveLink = async (
	props: LinkProps,
	summary: HumanSummary,
): Promise<void> => {
	await finalizeLink(props, summary);
	await maybeOfferConfigInit(props, summary);
};

/**
 * Offer to set up infrastructure-as-code at the end of an interactive `link` —
 * the natural moment, since the project is now linked. Skipped when the project
 * already has a `neon.ts` (nothing to scaffold). On yes, `config init` writes the
 * starter `neon.ts` and installs the config packages, then env is pulled again so
 * the local `.env` reflects the policy — the same pull `link` runs when a project
 * already ships a `neon.ts`.
 */
const maybeOfferConfigInit = async (
	props: LinkProps,
	summary: HumanSummary,
): Promise<void> => {
	const cwd = process.cwd();
	if (hasNeonConfigFile(cwd)) {
		return;
	}

	const { value } = await prompts({
		onState: onPromptState,
		type: "confirm",
		name: "value",
		message:
			"Manage this project's Neon setup as code? Adds a neon.ts you can edit and apply with `neon config apply`.",
		initial: true,
	});
	if (value !== true) {
		return;
	}

	await initCmd({ cwd, install: true });

	// The neon.ts (and its deps) now exist — pull env again so the local .env
	// reflects the policy, matching how `link` pulls when a project already ships
	// a neon.ts. Only meaningful when a branch was pinned (same guard as finalize).
	if (summary.branch && summary.projectId) {
		await autoPullEnvAfterPin({
			...props,
			projectId: summary.projectId,
			branch: summary.branch,
			envPull: props.envPull,
		});
	}
};

const onPromptState = (state: {
	value: InitialReturnValue;
	aborted: boolean;
	exited: boolean;
}) => {
	if (state.aborted) {
		process.stdout.write("\x1B[?25h");
		process.stdout.write("\n");
		process.exit(1);
	}
};

const mustString = <T>(value: T | undefined, name: string): T => {
	if (value === undefined) {
		throw new Error(`Internal error: expected ${name} to be set.`);
	}
	return value;
};
