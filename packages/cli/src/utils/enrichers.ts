import type { Branch, Database } from "@neon/sdk";
import { isNeonApiError, messageFromBody } from "../api.js";
import { isConfigAdd, isConfigInit, isCurrentBranchProbe } from "../context.js";
import type { BranchScopeProps, CommonProps, OrgScopeProps } from "../types.js";
import { looksLikeBranchId } from "./formats.js";

const BRANCHES_LIST_LIMIT = 100;

/**
 * Branch list pages cap at 100. A name stored in `.neon` can live on a later
 * page, so resolution has to walk `pagination.next` before treating it as missing.
 */
type BranchAnnotations = Awaited<
	ReturnType<CommonProps["apiClient"]["listProjectBranches"]>
>["data"]["annotations"];

/** Every branch of a project, with the annotations the listing returned for them. */
export type BranchListing = {
	branches: Branch[];
	annotations: BranchAnnotations;
};

export const listAllProjectBranchesWithAnnotations = async (
	apiClient: CommonProps["apiClient"],
	projectId: string,
): Promise<BranchListing> => {
	const branches: Branch[] = [];
	const annotations: BranchAnnotations = {};
	let cursor: string | undefined;
	while (true) {
		const { data } = await apiClient.listProjectBranches({
			projectId,
			limit: BRANCHES_LIST_LIMIT,
			cursor,
		});
		branches.push(...data.branches);
		Object.assign(annotations, data.annotations);
		cursor = data.pagination?.next;
		if (!cursor || data.branches.length === 0) {
			break;
		}
	}
	return { branches, annotations };
};

export const listAllProjectBranches = async (
	apiClient: CommonProps["apiClient"],
	projectId: string,
): Promise<Branch[]> =>
	(await listAllProjectBranchesWithAnnotations(apiClient, projectId))
		.branches;

export const branchIdResolve = async ({
	branch,
	apiClient,
	projectId,
	branches: listed,
}: {
	branch: string | number;
	apiClient: CommonProps["apiClient"];
	projectId: string;
	/** A listing this invocation already fetched; resolving by name reuses it. */
	branches?: Branch[];
}) => {
	branch = branch.toString();
	if (looksLikeBranchId(branch)) {
		return branch;
	}

	const branches =
		listed ?? (await listAllProjectBranches(apiClient, projectId));
	const branchData = branches.find((b: Branch) => b.name === branch);
	if (!branchData) {
		throw new Error(
			`Branch ${branch} not found.\nAvailable branches: ${branches
				.map((b: Branch) => b.name)
				.join(", ")}`,
		);
	}
	return branchData.id;
};

const getBranchIdFromProps = async (props: BranchScopeProps) => {
	const branch =
		"branch" in props && typeof props.branch === "string"
			? props.branch
			: (props as any).id;

	if (branch) {
		return await branchIdResolve({
			branch,
			apiClient: props.apiClient,
			projectId: props.projectId,
		});
	}

	const branches = await listAllProjectBranches(
		props.apiClient,
		props.projectId,
	);
	const defaultBranch = branches.find((b: Branch) => b.default);

	if (defaultBranch) {
		return defaultBranch.id;
	}

	throw new Error("No default branch found");
};

export const branchIdFromProps = async (props: BranchScopeProps) => {
	(props as any).branchId = await getBranchIdFromProps(props);
	return (props as any).branchId;
};

/**
 * {@link branchIdFromProps}, plus whatever the resolution already fetched: a name or the
 * default branch is resolved from a listing, so the branch object and the listing come back
 * with the id and callers need not fetch them again. An explicit `br-…` id is not listed.
 */
export const resolveBranchFromProps = async (
	props: BranchRefProps,
	/** A listing this invocation already fetched. */
	known?: BranchListing,
): Promise<{ branchId: string; branch?: Branch; listing?: BranchListing }> => {
	const ref = typeof props.branch === "string" ? props.branch : props.id;
	const explicit = ref ? String(ref) : undefined;

	if (explicit !== undefined && looksLikeBranchId(explicit)) {
		(props as any).branchId = explicit;
		return { branchId: explicit };
	}

	const listing =
		known ??
		(await listAllProjectBranchesWithAnnotations(
			props.apiClient,
			props.projectId,
		));
	const branch =
		explicit === undefined
			? listing.branches.find((b) => b.default)
			: listing.branches.find((b) => b.name === explicit);
	if (!branch) {
		throw new Error(
			explicit === undefined
				? "No default branch found"
				: `Branch ${explicit} not found.\nAvailable branches: ${listing.branches
						.map((b) => b.name)
						.join(", ")}`,
		);
	}
	(props as any).branchId = branch.id;
	return { branchId: branch.id, branch, listing };
};

/**
 * The branch a command is about to act on, resolved to **both** its id and its
 * human-readable name so callers can confirm the target to the user (see
 * {@link announceTargetBranch}) before mutating it.
 *
 * Resolution mirrors {@link branchIdFromProps}: an explicit `branch`/`id`
 * (name or `br-…` id) wins, otherwise the project's default branch is used. The
 * difference is that this always carries the name back, so it lists the
 * project's branches even for a `br-…` id (to look up the name). A `br-…` id the
 * listing doesn't return is still trusted as an id (matching `branchIdResolve`),
 * just with no friendlier name to show; a *name* that doesn't resolve is the
 * same hard error as before.
 */
export type ResolvedBranchRef = {
	branchId: string;
	/** Friendly branch name when known, otherwise the id. */
	branchName: string;
	/** True when no branch was specified and the project's default was used. */
	usedDefault: boolean;
	isDefault?: boolean;
	isProtected?: boolean;
	parentId?: string;
	expiresAt?: string;
};

/**
 * What resolving a branch reference actually needs. Narrower than
 * {@link BranchScopeProps} on purpose: every command's props satisfy it, and a caller that
 * holds only a client and a project (e.g. `config init --from-branch`) can call it without
 * inventing an `output` / `contextFile` / `apiKey` it has no use for.
 */
export type BranchRefProps = {
	apiClient: CommonProps["apiClient"];
	projectId: string;
	branch?: string | number;
	id?: string | number;
};

export const resolveBranchRef = async (
	props: BranchRefProps,
): Promise<ResolvedBranchRef> => {
	const branch = typeof props.branch === "string" ? props.branch : props.id;

	const branches = await listAllProjectBranches(
		props.apiClient,
		props.projectId,
	);

	const listingFields = (
		listed: Branch,
	): Pick<
		ResolvedBranchRef,
		"isDefault" | "isProtected" | "parentId" | "expiresAt"
	> => ({
		isDefault: listed.default === true,
		isProtected: listed.protected === true,
		...(listed.parent_id ? { parentId: listed.parent_id } : {}),
		...(listed.expires_at ? { expiresAt: listed.expires_at } : {}),
	});

	if (branch) {
		const ref = branch.toString();
		const found = looksLikeBranchId(ref)
			? branches.find((b: Branch) => b.id === ref)
			: branches.find((b: Branch) => b.name === ref);
		if (found) {
			return {
				branchId: found.id,
				branchName: found.name ?? found.id,
				usedDefault: false,
				...listingFields(found),
			};
		}
		// A `br-…` id absent from the listing is still usable as an id (trust it like
		// branchIdResolve does); only an unresolved *name* is a genuine error.
		if (looksLikeBranchId(ref)) {
			return { branchId: ref, branchName: ref, usedDefault: false };
		}
		throw new Error(
			`Branch ${ref} not found.\nAvailable branches: ${branches
				.map((b: Branch) => b.name)
				.join(", ")}`,
		);
	}

	const defaultBranch = branches.find((b: Branch) => b.default);
	if (!defaultBranch) {
		throw new Error("No default branch found");
	}
	return {
		branchId: defaultBranch.id,
		branchName: defaultBranch.name ?? defaultBranch.id,
		usedDefault: true,
		...listingFields(defaultBranch),
	};
};

export const resolveSingleDatabase = async (props: {
	apiClient: CommonProps["apiClient"];
	projectId: string;
	branchId: string;
	database?: string;
}): Promise<string> => {
	const { data } = await props.apiClient.listProjectBranchDatabases(
		props.projectId,
		props.branchId,
	);
	const databases = data.databases;

	if (props.database !== undefined) {
		if (!databases.find((d: Database) => d.name === props.database)) {
			throw new Error(
				`Database not found: ${props.database}. Available databases on branch ${props.branchId}: ${databases.map((d: Database) => d.name).join(", ")}`,
			);
		}
		return props.database;
	}

	if (databases.length === 0) {
		throw new Error(`No databases found for the branch: ${props.branchId}`);
	}
	if (databases.length === 1) {
		return databases[0].name;
	}
	throw new Error(
		`Multiple databases found for the branch, please provide one with the --database option: ${databases.map((d: Database) => d.name).join(", ")}`,
	);
};

export const fillSingleProject = async (
	props: CommonProps & { projectId?: string; orgId?: string },
) => {
	// The offline `--current-branch` probe needs no project at all and runs with no
	// API client (auth was skipped), so resolving a single project here would both
	// hit the network and dereference a null client. Skip it entirely.
	if (isCurrentBranchProbe(props as any)) {
		return props;
	}

	// `config init` is purely local (scaffold + npm install) and runs with no API
	// client, so resolving a single project here would dereference a null client.
	if (isConfigInit(props as any)) {
		return props;
	}

	// `config add` edits the local neon.ts and never needs a project either.
	if (isConfigAdd(props as any)) {
		return props;
	}
	if (props.projectId) {
		return { ...props, projectId: props.projectId };
	}

	// If no orgId is provided, try to auto-fill it if there's only one org
	let orgId = props.orgId;
	if (!orgId) {
		const { data: orgsData } =
			await props.apiClient.getCurrentUserOrganizations();
		if (orgsData.organizations.length === 1) {
			orgId = orgsData.organizations[0].id;
		}
	}

	try {
		const { data } = await props.apiClient.listProjects({
			limit: 2,
			org_id: orgId,
		});
		if (data.projects.length === 0) {
			throw new Error("No projects found");
		}
		if (data.projects.length > 1) {
			throw new Error(
				`Multiple projects found, please provide one with the --project-id option`,
			);
		}
		return {
			...props,
			projectId: data.projects[0].id,
		};
	} catch (error) {
		// If the API error is about missing org_id, provide a user-friendly message
		if (
			isNeonApiError(error) &&
			error.status === 400 &&
			messageFromBody(error.data)?.includes("org_id is required")
		) {
			throw new Error(
				"Multiple projects found, please provide one with the --project-id option",
			);
		}
		throw error;
	}
};

export const fillSingleOrg = async (props: OrgScopeProps) => {
	if (props.orgId) {
		return props;
	}
	const { data } = await props.apiClient.getCurrentUserOrganizations();
	if (data.organizations.length === 0) {
		throw new Error("No organizations found");
	}
	if (data.organizations.length > 1) {
		throw new Error(
			`Multiple organizations found, please provide one with the --org-id option`,
		);
	}
	return { ...props, orgId: data.organizations[0].id };
};
