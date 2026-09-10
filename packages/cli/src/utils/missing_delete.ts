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
 * Label for a missing-delete message from values already in hand. A second
 * list after 204 would be able to replace the not-found result.
 */
export const branchNameForMissingDelete = (
	props: BranchScopeProps,
	branchId: string,
): string => {
	const ref =
		"branch" in props && typeof props.branch === "string"
			? props.branch
			: undefined;
	if (ref !== undefined && !looksLikeBranchId(ref)) {
		return ref;
	}
	return ref ?? branchId;
};
