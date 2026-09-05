import type { Branch } from "@neon/sdk";
import type { BranchScopeProps, CommonProps } from "../types.js";
import { writer } from "../writer.js";
import { looksLikeBranchId } from "./formats.js";

/**
 * Report a delete that returned HTTP 204. Table mode throws so the CLI
 * prints ERROR on stderr; JSON/YAML keep the payload on stdout, so we
 * set exitCode instead of throwing.
 */
export const reportMissingDelete = (
	props: Pick<CommonProps, "output">,
	message: string,
): void => {
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(
			{ deleted: false, message },
			{ fields: ["deleted", "message"] },
		);
		process.exitCode = 1;
		return;
	}
	throw new Error(message);
};

/**
 * Friendly branch label for a missing-delete message. A name the user
 * already passed is enough; listing is only for a `br-…` id or the default.
 */
export const branchNameForMissingDelete = async (
	props: BranchScopeProps,
	branchId: string,
): Promise<string> => {
	const ref =
		"branch" in props && typeof props.branch === "string"
			? props.branch
			: undefined;
	if (ref !== undefined && !looksLikeBranchId(ref)) {
		return ref;
	}
	const { data } = await props.apiClient.listProjectBranches({
		projectId: props.projectId,
	});
	const found = data.branches.find((b: Branch) => b.id === branchId);
	return found?.name ?? branchId;
};
