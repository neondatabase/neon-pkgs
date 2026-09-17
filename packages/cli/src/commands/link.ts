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
import { defaultDir } from "../config.js";
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
import { listAllProjectBranches } from "../utils/enrichers.js";
import { looksLikeBranchId } from "../utils/formats.js";
import { helpEpilogue } from "../utils/help_text.js";
import { writer } from "../writer.js";
import { hasNeonConfigFile, initCmd } from "./config.js";
import { autoPullEnvAfterPin } from "./env.js";
import { REGIONS } from "./projects.js";

const PROJECTS_LIST_LIMIT = 100;

const CREATE_NEW_SENTINEL = "__create_new__";

export type LinkProps = CommonProps & {
	orgId?: string;
	projectId?: string;
	projectName?: string;
	regionId?: string;
	branch?: string;
	params?: string;
	yes: boolean;
	clear: boolean;
	checks: boolean;
	envPull: boolean;
	config?: boolean;
	cwd?: string;
	profile?: string;
	configDir?: string;
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
		`${cli} link -y`,
		`${cli} orgs list --output json`,
		`${cli} projects list --org-id <org-id> --output json`,
		`${cli} link --project-id <project-id> [--branch <name> | -y]`,
		`${cli} link --org-id <org-id> --project-name <name> --region-id aws-us-east-2`,
	];
};

const nonInteractiveLinkHelp = (): string =>
	nonInteractiveLinkCommands()
		.map((command) => `  ${command}`)
		.join("\n");

const orgScopedKeyHint =
	"Organization-scoped API keys cannot list orgs; pass --org-id.";

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
					"Branch name or ID to pin in the context (resolved to its name before writing).",
				type: "string",
			},
			params: {
				describe:
					'JSON object with link parameters, e.g. \'{"orgId":"...","projectId":"..."}\' or \'{"orgId":"...","projectName":"...","regionId":"..."}\'. Flags take precedence over fields in --params.',
				type: "string",
			},
			yes: {
				alias: "y",
				describe:
					"Skip prompts. Select the only organization and project, or print IDs and the flag to pass. Pin the default branch when several exist. Does not create a project unless --project-name and --region-id are set.",
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
					"calls — it then requires --org-id, --project-id, and --branch, and skips env pull.",
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
			config: {
				describe:
					"Offer to create neon.ts after interactive linking. Use --no-config to skip the offer",
				type: "boolean",
				default: true,
			},
		})
		.example([
			[
				"$0 link -y",
				"Select the only organization and project, or print the --org-id / --project-id to pass",
			],
			[
				"$0 link --project-id polished-snowflake-12345678",
				"Link an existing project (org is inferred). Pins the only branch; several prompt in a TTY, or -y pins the default",
			],
			[
				"$0 link --project-id polished-snowflake-12345678 -y",
				"Same, pinning the project's default branch when several exist",
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
				"$0 link --no-checks --org-id org-… --project-id polished-snowflake-12345678 --branch main",
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
		.strict();

export const runLink = async (props: LinkProps) => {
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

	if (props.yes && hasIncompleteCreationInputs(inputs)) {
		throw incompleteCreationError(props, inputs);
	}

	if (canResolveNonInteractively(inputs, existing)) {
		await runNonInteractive(props, inputs, existing);
		return;
	}

	if (props.yes) {
		const resolved = await resolveYesInputs(props, inputs);
		await runNonInteractive(props, resolved, existing);
		return;
	}

	if (!canPromptInteractively()) {
		if (missingProjectForOrg(inputs)) {
			throw orgNeedsProjectError(props, inputs);
		}
		throw new LinkInputError(
			[
				"Missing inputs and no interactive terminal for prompts.",
				"",
				"Use:",
				nonInteractiveLinkHelp(),
				orgScopedKeyHint,
			].join("\n"),
		);
	}

	await runInteractive(props, inputs);
};

export const handler = runLink;

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

const hasIncompleteCreationInputs = (inputs: Inputs): boolean =>
	Boolean(inputs.projectName) !== Boolean(inputs.regionId);

const missingProjectForOrg = (inputs: Inputs): boolean =>
	Boolean(inputs.orgId) && !inputs.projectId && !inputs.projectName;

const orgNeedsProjectError = (
	props: LinkProps,
	inputs: Inputs,
): LinkInputError => {
	const orgId = inputs.orgId ?? "<org-id>";
	const branchFlag = inputs.branch
		? ` --branch ${quoteFlagValue(inputs.branch)}`
		: "";
	const session = sessionRetryFlags(props);
	return new LinkInputError(
		[
			"No project selected. Pass --project-id, or use -y to select the only project:",
			`  ${getCliName()} link -y --org-id ${quoteFlagValue(orgId)}${branchFlag}${session}`,
			`  ${getCliName()} link --project-id <project-id>${
				inputs.branch
					? ` --branch ${quoteFlagValue(inputs.branch)}`
					: " --branch <name-or-id>"
			}${session}`,
		].join("\n"),
	);
};

const quoteFlagValue = (value: string): string => {
	if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
};

const sessionRetryFlags = (props: LinkProps): string => {
	const flags: string[] = [];
	if (props.contextFile) {
		flags.push(`--context-file ${quoteFlagValue(props.contextFile)}`);
	}
	if (props.configDir && props.configDir !== defaultDir) {
		flags.push(`--config-dir ${quoteFlagValue(props.configDir)}`);
	}
	if (props.output !== "table") {
		flags.push(`--output ${props.output}`);
	}
	if (!props.envPull) {
		flags.push("--no-env-pull");
	}
	if (props.profile) {
		flags.push(`--profile ${quoteFlagValue(props.profile)}`);
	}
	return flags.length > 0 ? ` ${flags.join(" ")}` : "";
};

const incompleteCreationError = (
	props: LinkProps,
	inputs: Inputs,
): LinkInputError => {
	const orgFlag = inputs.orgId
		? `--org-id ${quoteFlagValue(inputs.orgId)}`
		: "--org-id <org-id>";
	const nameFlag = inputs.projectName
		? `--project-name ${quoteFlagValue(inputs.projectName)}`
		: "--project-name <name>";
	const regionFlag = inputs.regionId
		? `--region-id ${quoteFlagValue(inputs.regionId)}`
		: "--region-id aws-us-east-2";
	const example = `${getCliName()} link -y ${orgFlag} ${nameFlag} ${regionFlag}${sessionRetryFlags(props)}`;
	if (inputs.projectName) {
		return new LinkInputError(
			`--project-name requires --region-id. Example:\n  ${example}`,
		);
	}
	return new LinkInputError(
		`--region-id requires --project-name. Example:\n  ${example}`,
	);
};

/**
 * Branch selection may still prompt after org and project resolve without the
 * org/project wizard.
 */
const canResolveNonInteractively = (
	inputs: Inputs,
	existing: Context,
): boolean => {
	if (inputs.projectId) return true;
	if (inputs.orgId && inputs.projectName && inputs.regionId) return true;
	if (inputs.branch && existing.projectId) return true;
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
 * the caller must supply `--org-id`, `--project-id`, and `--branch`. This is
 * the CLI surface over {@link setContext}, useful for scripted/offline setups
 * and for re-creating a `.neon` from values you already trust.
 */
const runWithoutChecks = (props: LinkProps): void => {
	const inputs = parseInputs(props);
	validateInputs(inputs);
	if (inputs.projectName) {
		throw new Error(
			"--no-checks can't create a project (that needs API access). Pass --org-id and --project-id for an existing project, or drop --no-checks.",
		);
	}
	if (!inputs.orgId || !inputs.projectId || !inputs.branch) {
		throw new Error(
			"--no-checks requires --org-id, --project-id, and --branch because identifiers cannot be resolved offline.",
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

const failWithBranchCandidates = (
	props: LinkProps,
	projectId: string,
	branches: Branch[],
	reason: string,
): never => {
	writer(props).end(
		branches.map((b) => ({
			id: b.id,
			name: b.name ?? b.id,
		})),
		{
			fields: ["id", "name"] as const,
			title: "Branches",
		},
	);
	const orgFlag = props.orgId
		? ` --org-id ${quoteFlagValue(props.orgId)}`
		: "";
	throw new LinkInputError(
		`${reason}\n  ${getCliName()} link -y${orgFlag} --project-id ${quoteFlagValue(projectId)} --branch <name-or-id>${sessionRetryFlags(props)}`,
	);
};

const listAllBranches = async (
	props: CommonProps,
	projectId: string,
): Promise<Branch[]> => listAllProjectBranches(props.apiClient, projectId);

/**
 * Resolve a branch reference (name *or* id) to the matching branch, while
 * confirming it actually exists in the project. Unlike the shared
 * `branchIdResolve`, this also verifies references that already look like ids
 * (so a typo'd `br-…` doesn't silently get written).
 */
const resolveBranchRef = async (
	props: LinkProps,
	projectId: string,
	branchRef: string,
): Promise<Branch> => {
	const branches = await listAllBranches(props, projectId);
	const match =
		branches.find((b: Branch) => b.id === branchRef) ??
		branches.find((b: Branch) => b.name === branchRef);
	if (match) {
		return match;
	}
	return failWithBranchCandidates(
		props,
		projectId,
		branches,
		`Branch '${branchRef}' not found in project '${projectId}'. Pass --branch with a name or ID from the list:`,
	);
};

/**
 * Persist the name when later commands will look it up as a name. A name that
 * already looks like a branch id is trusted as an id without listing, so keep
 * the real id in that case.
 */
const branchPersistValue = (branch: { id: string; name?: string }): string => {
	if (branch.name && !looksLikeBranchId(branch.name)) {
		return branch.name;
	}
	return branch.id;
};

/**
 * Verify the project (and the org, when supplied) and resolve the org id to
 * persist.
 *
 * The project is always fetched, which both validates it and yields its
 * `org_id`. When `--org-id` is passed too: if the project reports an org it must
 * match (else a clear mismatch error); if it reports none, fail rather than
 * attaching an unrelated org. Without `--org-id` the project's own org is used.
 * Projects on a personal account have no org, so `undefined` is a valid result —
 * the field is simply omitted.
 */
const resolveOrgForProject = async (
	props: CommonProps,
	inputs: Inputs,
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
			throw new LinkInputError(
				`Project '${projectId}' does not report an organization matching --org-id ${inputs.orgId}. Omit --org-id to link using the project's own context.`,
			);
		}
		return inputs.orgId;
	}

	if (projectOrg) {
		return projectOrg;
	}
	return undefined;
};

type BranchResolution = {
	branch: string;
};

/**
 * Keep a same-project pin only after it still resolves on the project.
 */
const resolvePinnedBranch = async (
	props: LinkProps,
	inputs: Inputs,
	existing: Context,
	projectId: string,
): Promise<BranchResolution> => {
	if (inputs.branch) {
		const branch = await resolveBranchRef(props, projectId, inputs.branch);
		return { branch: branchPersistValue(branch) };
	}
	if (projectId === existing.projectId) {
		const pinned = contextBranch(existing);
		if (pinned) {
			const branch = await resolveBranchRef(props, projectId, pinned);
			return { branch: branchPersistValue(branch) };
		}
	}
	return resolveBranchFromList(props, projectId);
};

const resolveBranchFromList = async (
	props: LinkProps,
	projectId: string,
): Promise<BranchResolution> => {
	const branches = await listAllBranches(props, projectId);
	if (branches.length === 0) {
		throw new LinkInputError(
			`Project '${projectId}' has no branches to link. Create or restore a branch before retrying, or select another project with --project-id.`,
		);
	}
	if (branches.length === 1) {
		const [only] = branches;
		if (!only) {
			throw new LinkInputError(
				`Project '${projectId}' has no branches to link. Create or restore a branch before retrying, or select another project with --project-id.`,
			);
		}
		return { branch: branchPersistValue(only) };
	}
	if (props.yes) {
		const def = branches.find((b: Branch) => b.default);
		if (!def) {
			return failWithBranchCandidates(
				props,
				projectId,
				branches,
				`Project '${projectId}' has no default branch. Pass --branch with a name or ID from the list:`,
			);
		}
		return { branch: branchPersistValue(def) };
	}
	if (canPromptInteractively()) {
		const picked = await pickBranchInteractively(branches, {
			message: "Which branch would you like to link?",
			nonInteractiveMessage:
				"No branch could be selected without an interactive terminal. " +
				`Pass --branch <name-or-id>, or -y to pin the default branch.`,
		});
		if (picked.kind === "existing") {
			const existing = branches.find(
				(b: Branch) => b.id === picked.branchId,
			);
			return {
				branch: existing
					? branchPersistValue(existing)
					: picked.branchId,
			};
		}
		const created = await createBranch(
			props.apiClient,
			projectId,
			picked.name,
			branches,
		);
		return {
			branch: branchPersistValue({
				id: created,
				name: picked.name,
			}),
		};
	}
	return failWithBranchCandidates(
		props,
		projectId,
		branches,
		`Project '${projectId}' has multiple branches. Pass --branch <name-or-id>, or -y to pin its default branch.`,
	);
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
			inputs.projectId,
		);
		const resolved = await resolvePinnedBranch(
			props,
			inputs,
			existing,
			inputs.projectId,
		);
		applyContext(props.contextFile, {
			orgId,
			projectId: inputs.projectId,
			branch: resolved.branch,
		});
		await finalizeLink(props, {
			contextFile: props.contextFile,
			orgId,
			projectId: inputs.projectId,
			branch: resolved.branch,
			created: false,
		});
		return;
	}

	// Pin a branch in the already-linked project.
	if (inputs.branch && existing.projectId) {
		const projectId = existing.projectId;
		const orgId = await resolveOrgForProject(props, inputs, projectId);
		const resolved = await resolvePinnedBranch(
			props,
			inputs,
			existing,
			projectId,
		);
		applyContext(props.contextFile, {
			orgId,
			projectId,
			branch: resolved.branch,
		});
		await finalizeLink(props, {
			contextFile: props.contextFile,
			orgId,
			projectId,
			branch: resolved.branch,
			created: false,
		});
		return;
	}

	throw orgNeedsProjectError(props, inputs);
};

// ----------------------------------------------------------------------------
// Interactive mode (TTY)
// ----------------------------------------------------------------------------

const runInteractive = async (props: LinkProps, inputs: Inputs) => {
	if (!props.yes) {
		const proceed = await confirmRelinkIfNeeded(props);
		if (!proceed) {
			return;
		}
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
		if (inputs.branch) {
			throw new Error(
				`Conflicting inputs: --branch pins a branch of an existing project, but --project-name creates a new one. Create the project first, then \`${getCliName()} checkout <branch>\`.`,
			);
		}
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
	const action = await promptProjectChoice(projects, inputs.projectName, {
		allowCreate: !inputs.branch,
	});

	if (action.type === "existing") {
		const existing = readContextFile(props.contextFile);
		const resolved = await resolvePinnedBranch(
			props,
			inputs,
			existing,
			action.projectId,
		);
		applyContext(props.contextFile, {
			orgId,
			projectId: action.projectId,
			branch: resolved.branch,
		});
		await finalizeInteractiveLink(props, {
			contextFile: props.contextFile,
			orgId,
			projectId: action.projectId,
			branch: resolved.branch,
			created: false,
			projectName: action.name,
			regionId: action.regionId,
		});
		return;
	}

	if (inputs.branch) {
		throw new Error(
			`Conflicting inputs: --branch pins a branch of an existing project, but creating a project starts from its default branch. Link an existing project, or omit --branch and create first.`,
		);
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

const confirmRelinkIfNeeded = async (props: LinkProps): Promise<boolean> => {
	const existing = readContextFile(props.contextFile);
	if (!existing.projectId) {
		return true;
	}
	const { proceed } = await prompts({
		onState: onPromptState,
		type: "confirm",
		name: "proceed",
		message: existing.orgId
			? `${props.contextFile} is already linked to project ${existing.projectId} (org ${existing.orgId}). Re-link?`
			: `${props.contextFile} is already linked to project ${existing.projectId}. Re-link?`,
		initial: true,
	});
	if (!proceed) {
		process.stdout.write("Aborted. Existing link preserved.\n");
		return false;
	}
	return true;
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
	suggestedName: string | undefined,
	opts: { allowCreate: boolean },
): Promise<ProjectChoice> => {
	const choices = [
		...(opts.allowCreate
			? [{ title: "＋ Create new project…", value: CREATE_NEW_SENTINEL }]
			: []),
		...projects.map((project) => ({
			title: `${project.name} (${project.id})`,
			value: project.id,
		})),
	];
	if (choices.length === 0) {
		throw new LinkInputError(
			"No projects are available to link. Omit --branch to create a project, or pass --project-id for an existing one.",
		);
	}
	const createOffset = opts.allowCreate ? 1 : 0;
	const { selection } = await prompts({
		onState: onPromptState,
		type: "select",
		name: "selection",
		message: "Which project would you like to link?",
		choices,
		initial: projects.length > 0 ? createOffset : 0,
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

type NamedCandidate = {
	id: string;
	name: string;
};

const CANDIDATE_FIELDS = ["id", "name"] as const;

const extraYesFlags = (props: LinkProps, inputs: Inputs): string => {
	const flags: string[] = [];
	if (inputs.projectName) {
		flags.push(`--project-name ${quoteFlagValue(inputs.projectName)}`);
	}
	if (inputs.regionId) {
		flags.push(`--region-id ${quoteFlagValue(inputs.regionId)}`);
	}
	if (inputs.branch) {
		flags.push(`--branch ${quoteFlagValue(inputs.branch)}`);
	}
	const named = flags.length > 0 ? ` ${flags.join(" ")}` : "";
	return `${named}${sessionRetryFlags(props)}`;
};

const yesProjectIdCommand = (props: LinkProps, inputs: Inputs): string =>
	`${getCliName()} link -y --project-id <project-id>${
		inputs.branch ? ` --branch ${quoteFlagValue(inputs.branch)}` : ""
	}${sessionRetryFlags(props)}`;

const printNamedCandidates = (
	props: LinkProps,
	title: string,
	items: NamedCandidate[],
): void => {
	writer(props).end(items, {
		fields: CANDIDATE_FIELDS,
		title,
	});
};

const orgScopedKeyNeedsOrgId = (): LinkInputError =>
	new LinkInputError(
		"This API key is organization-scoped, so the CLI cannot list your organizations, " +
			"and no existing project was found in this org to auto-detect the ID. " +
			"Re-run with `--org-id <your_org_id>` (find it in the Neon Console under Settings).",
	);

const resolveYesOrgId = async (
	props: LinkProps,
	inputs: Inputs,
): Promise<string> => {
	const orgResolution = await resolveOrg(props, inputs.orgId);
	if (orgResolution.kind === "resolved") {
		if (orgResolution.autoDetected) {
			log.info(
				`Detected organization ${orgResolution.orgId} from your existing projects (organization-scoped API key).`,
			);
		}
		return orgResolution.orgId;
	}
	if (orgResolution.orgKeyLimited) {
		throw orgScopedKeyNeedsOrgId();
	}
	const orgs = orgResolution.orgs;
	if (orgs.length === 0) {
		throw new LinkInputError(
			[
				"No organizations were returned for this account. Pass --project-id for a project you can access:",
				`  ${yesProjectIdCommand(props, inputs)}`,
			].join("\n"),
		);
	}
	if (orgs.length === 1) {
		const [only] = orgs;
		return only.id;
	}
	printNamedCandidates(
		props,
		"Organizations",
		orgs.map((org) => ({ id: org.id, name: org.name })),
	);
	throw new LinkInputError(
		[
			"Multiple organizations are available. Pass --org-id with an ID from the list:",
			`  ${getCliName()} link -y --org-id <org-id>${extraYesFlags(props, inputs)}`,
		].join("\n"),
	);
};

const resolveYesInputs = async (
	props: LinkProps,
	inputs: Inputs,
): Promise<Inputs> => {
	const orgId = await resolveYesOrgId(props, inputs);
	if (inputs.projectName && inputs.regionId) {
		return { ...inputs, orgId };
	}
	const projects = await listAllProjects(props, orgId);
	if (projects.length === 0) {
		throw new LinkInputError(
			[
				`No projects are available in organization '${orgId}'.`,
				"To create and link a project, pass --project-name and --region-id:",
				`  ${getCliName()} link -y --org-id ${quoteFlagValue(orgId)} --project-name <name> --region-id aws-us-east-2${sessionRetryFlags(props)}`,
			].join("\n"),
		);
	}
	if (projects.length === 1) {
		const [only] = projects;
		return { ...inputs, orgId, projectId: only.id };
	}
	printNamedCandidates(
		props,
		"Projects",
		projects.map((project) => ({ id: project.id, name: project.name })),
	);
	throw new LinkInputError(
		[
			`Multiple projects are available in organization '${orgId}'. Pass --project-id with an ID from the list:`,
			`  ${yesProjectIdCommand(props, inputs)}`,
		].join("\n"),
	);
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
	projectId: string;
	branch: string;
	created: boolean;
	projectName?: string;
	regionId?: string;
	/** True for the `--no-checks` path: written offline, so suppress env pull. */
	noChecks?: boolean;
};

const printSummary = (_props: LinkProps, summary: HumanSummary): void => {
	const lines: string[] = [];
	if (summary.created) {
		lines.push(
			`Created project ${summary.projectId}${summary.projectName ? ` ("${summary.projectName}")` : ""}${summary.regionId ? ` in ${summary.regionId}` : ""}.`,
		);
	}
	lines.push(`Linked ${summary.contextFile}:`);
	if (summary.orgId) {
		lines.push(`  orgId:     ${summary.orgId}`);
	}
	lines.push(`  projectId: ${summary.projectId}`);
	lines.push(`  branch:    ${summary.branch}`);
	if (summary.noChecks) {
		lines.push("");
		lines.push("Written offline (--no-checks): nothing was verified.");
	}
	lines.push("");
	process.stdout.write(`${lines.join("\n")}\n`);
};

/**
 * Print the link summary, then run the bundled `env pull` so a completed `link` ends with
 * the pinned branch's connection string on disk. `--no-checks` skips the pull because
 * nothing was verified. `--no-env-pull` opts out (env pull's own status / skip hint is
 * logged to stderr).
 */
const finalizeLink = async (
	props: LinkProps,
	summary: HumanSummary,
): Promise<void> => {
	printSummary(props, summary);
	if (!summary.branch || !summary.projectId || summary.noChecks) {
		return;
	}
	const { config: _offerConfig, ...rest } = props;
	await autoPullEnvAfterPin({
		...rest,
		...(props.cwd ? { cwd: props.cwd } : {}),
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
 * Interactive `link` offers neon.ts only when the directory has none and the
 * caller did not pass --no-config. Init always passes --no-config so it can ask
 * once after linking.
 */
export const shouldOfferConfigInit = (input: {
	hasConfig: boolean;
	offer: boolean;
}): boolean => !input.hasConfig && input.offer;

const maybeOfferConfigInit = async (
	props: LinkProps,
	summary: HumanSummary,
): Promise<void> => {
	const cwd = props.cwd ?? process.cwd();
	if (
		!shouldOfferConfigInit({
			hasConfig: hasNeonConfigFile(cwd),
			offer: props.config !== false,
		})
	) {
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
		const { config: _offerConfig, ...rest } = props;
		await autoPullEnvAfterPin({
			...rest,
			cwd,
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
