import type { Branch } from "@neon/sdk";
import type { NeonApiClient } from "../api.js";
import { branchIdResolve } from "./enrichers.js";
import { looksLikeLSN, looksLikeTimestamp } from "./formats.js";

export type PointInTime =
	| {
			tag: "head";
	  }
	| {
			tag: "lsn";
			lsn: string;
	  }
	| {
			tag: "timestamp";
			timestamp: string;
	  };
export type PointInTimeBranchId = {
	branchId: string;
} & PointInTime;

export type PointInTimeBranch = {
	branch: string;
} & PointInTime;

export type PointInTimeProps = {
	targetBranchId: string;
	pointInTime: string;
	projectId: string;
	api: NeonApiClient;
	/** A listing this invocation already fetched; a source branch name is resolved from it. */
	branches?: Branch[];
	/** The target branch, when already fetched; `^parent` reads its `parent_id`. */
	targetBranch?: Branch;
};

export class PointInTimeParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PointInTimeParseError";
	}
}

export const parsePITBranch = (input: string) => {
	const splitIndex = input.lastIndexOf("@");
	const sourceBranch = splitIndex === -1 ? input : input.slice(0, splitIndex);
	const exactPIT = splitIndex === -1 ? null : input.slice(splitIndex + 1);
	const result = {
		branch: sourceBranch,
		...(exactPIT === null
			? { tag: "head" }
			: looksLikeLSN(exactPIT)
				? { tag: "lsn", lsn: exactPIT }
				: { tag: "timestamp", timestamp: exactPIT }),
	} satisfies PointInTimeBranch;
	if (result.tag === "timestamp") {
		const timestamp = result.timestamp;
		if (!looksLikeTimestamp(timestamp)) {
			throw new PointInTimeParseError(
				`Invalid source branch format - ${input}`,
			);
		}
		if (Date.parse(timestamp) > Date.now()) {
			throw new PointInTimeParseError(
				`Timestamp can not be in future - ${input}`,
			);
		}
	}
	return result;
};

export const parsePointInTime = async ({
	pointInTime,
	targetBranchId,
	projectId,
	api,
	branches,
	targetBranch,
}: PointInTimeProps): Promise<PointInTimeBranchId> => {
	const parsedPIT = parsePITBranch(pointInTime);

	let branchId = "";
	if (parsedPIT.branch === "^self") {
		branchId = targetBranchId;
	} else if (parsedPIT.branch === "^parent") {
		const target =
			targetBranch?.id === targetBranchId
				? targetBranch
				: (await api.getProjectBranch(projectId, targetBranchId)).data
						.branch;
		const parentId = target.parent_id;
		if (parentId == null) {
			throw new PointInTimeParseError("Branch has no parent");
		}
		branchId = parentId;
	} else {
		branchId = await branchIdResolve({
			branch: parsedPIT.branch,
			projectId,
			apiClient: api,
			branches,
		});
	}

	// @ts-expect-error extracting pit from parsedPIT
	delete parsedPIT.branch;
	return { ...parsedPIT, branchId };
};
