import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { isFunctionBaseUrlKey } from "@neon-internals/env-core/env";
import chalk from "chalk";
import {
	BRANCH_ENV_KEY,
	ENV_PULL_KEYS,
	serviceForEnvKey,
} from "../env_services.js";
import { NEON_SERVICE_LABELS, NEON_SERVICES } from "../neon_services.js";
import type { ResolvedBranchRef } from "../utils/enrichers.js";
import type { PullOutcome } from "./env.js";

/** Wide enough for the longest label ("Object Storage") plus a gutter, so blocks align. */
const LABEL_WIDTH = 16;

export const row = (label: string, value: string): string =>
	`  ${label.padEnd(LABEL_WIDTH)}${value}`;

/** Relative to `cwd` when the file is inside it, else absolute with the home directory as `~`. */
export const displayPath = (file: string, cwd: string): string => {
	const rel = relative(cwd, file);
	if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
	const home = homedir();
	return file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
};

const BRANCH_GROUP = "Branch";
const OTHER_GROUP = "Other";
const GROUP_ORDER = [
	NEON_SERVICE_LABELS.postgres,
	BRANCH_GROUP,
	...NEON_SERVICES.filter((service) => service !== "postgres").map(
		(service) => NEON_SERVICE_LABELS[service],
	),
	OTHER_GROUP,
];

const groupOf = (key: string): string => {
	if (key === BRANCH_ENV_KEY) return BRANCH_GROUP;
	if (isFunctionBaseUrlKey(key)) return NEON_SERVICE_LABELS.functions;
	const pullKey = ENV_PULL_KEYS.find((candidate) => candidate === key);
	const service = pullKey ? serviceForEnvKey(pullKey) : null;
	return service ? NEON_SERVICE_LABELS[service] : OTHER_GROUP;
};

/** Canonical key order, so a row reads the same whether a key was rewritten or reused. */
const keyRank = (key: string): number => {
	const index = ENV_PULL_KEYS.findIndex((candidate) => candidate === key);
	return index === -1 ? ENV_PULL_KEYS.length : index;
};

const byKeyRank = (a: string, b: string): number =>
	keyRank(a) - keyRank(b) || a.localeCompare(b);

const groupKeys = (keys: readonly string[]): Map<string, string[]> => {
	const groups = new Map<string, string[]>();
	for (const key of [...keys].sort(byKeyRank)) {
		const group = groupOf(key);
		groups.set(group, [...(groups.get(group) ?? []), key]);
	}
	return groups;
};

/** `branch dev (br-…)`, with `, project default` when no branch was named. */
export const pulledBranch = (branch: ResolvedBranchRef): string =>
	`branch ${chalk.cyan.bold(branch.branchName)} ${chalk.dim(
		`(${branch.branchId}${branch.usedDefault ? ", project default" : ""})`,
	)}`;

export const formatPulledEnv = (
	outcome: Extract<PullOutcome, { status: "written" }>,
	cwd: string,
	branch?: ResolvedBranchRef,
): string => {
	const fresh = new Set(outcome.credential?.fresh ?? []);
	const count = outcome.written.length;
	const source = branch ? ` from ${pulledBranch(branch)}` : "";
	const lines = [
		`Pulled ${count} Neon variable${count === 1 ? "" : "s"} into ${displayPath(outcome.file, cwd)}${source}`,
	];
	const groups = groupKeys(outcome.written);
	for (const group of GROUP_ORDER) {
		const keys = groups.get(group);
		if (!keys) continue;
		lines.push(
			row(
				group,
				keys
					.map((key) => (fresh.has(key) ? `${key}*` : key))
					.join(", "),
			),
		);
	}
	if (outcome.removed.length > 0) {
		lines.push(
			row(
				"Removed",
				`${outcome.removed.join(", ")} (not produced by this pull)`,
			),
		);
	}
	if (fresh.size > 0) {
		lines.push("  * new credential value");
	}
	const credential = outcome.credential;
	if (credential?.issued && credential.revoked.length > 0) {
		lines.push(
			`Revoked the credential it replaced (${credential.revoked.join(", ")}).`,
		);
	} else if (credential?.issued && credential.superseded.length > 0) {
		lines.push(
			`Left the credential it replaced live (${credential.superseded.join(", ")}): an explicitly scoped pull can't tell which other variables still use it. Revoke it in the Neon Console if nothing does.`,
		);
	}
	return `${lines.join("\n")}\n`;
};
