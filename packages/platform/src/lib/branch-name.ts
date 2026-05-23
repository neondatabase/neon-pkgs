import { randomBytes } from "node:crypto";
import { fillPattern } from "./patterns.js";

/** Default cap on collision retries when generating an ephemeral branch name. */
export const DEFAULT_MAX_ATTEMPTS = 10;

/** Max length of a Neon branch name (matches the limit enforced by {@link validatePattern}). */
const MAX_BRANCH_NAME_LENGTH = 256;

/**
 * Sanitize a git branch name into a fragment safe to embed in a Neon branch name.
 *
 * Neon allows letters, digits, `-`, `_`, `.`, `/` in branch names, but `/` interacts
 * awkwardly with shell pipelines and downstream tooling so we collapse it to `-`. The
 * full transform:
 * 1. Lowercase the input (Neon names are case-sensitive but we normalize for stability).
 * 2. Replace any character outside `[a-z0-9._-]` with `-` (this also turns `/` into `-`).
 * 3. Collapse runs of `-` into a single `-`.
 * 4. Trim leading/trailing `-` and `.`.
 *
 * Returns `null` if nothing meaningful survives the sanitization (e.g. an all-symbols name).
 *
 * @example
 * normalizeGitBranch("andrelandgraf/new-feature") // → "andrelandgraf-new-feature"
 * normalizeGitBranch("Feat/Foo Bar")              // → "feat-foo-bar"
 * normalizeGitBranch("___")                       // → null
 */
export function normalizeGitBranch(name: string): string | null {
	const lowered = name.toLowerCase();
	const replaced = lowered.replace(/[^a-z0-9._-]+/g, "-");
	const collapsed = replaced.replace(/-+/g, "-");
	const trimmed = collapsed.replace(/^[-.]+|[-.]+$/g, "");
	return trimmed === "" ? null : trimmed;
}

/**
 * Generate a short alphanumeric identifier suitable for disambiguating ephemeral branch
 * names. Uses 24 bits of CSPRNG entropy rendered as 6 lowercase hex characters
 * (`~16M` possibilities) — plenty for collision avoidance within a single Neon project's
 * branch namespace.
 */
export function generateMiniId(): string {
	return randomBytes(3).toString("hex");
}

export interface BuildBranchNameInput {
	/** Blueprint pattern, e.g. `"preview-*"`. */
	pattern: string;
	/**
	 * Normalised git branch fragment (output of {@link normalizeGitBranch}). When provided,
	 * the unique suffix becomes `<gitBranch>-<miniId>`; otherwise it's just `<miniId>`.
	 */
	gitBranch?: string;
	/** Short random identifier from {@link generateMiniId} (or a test injection). */
	miniId: string;
}

/**
 * Compose an ephemeral branch name from a blueprint pattern, an optional git branch
 * fragment, and a random mini-id. Truncates the result to {@link MAX_BRANCH_NAME_LENGTH}
 * by trimming from the *end of the git fragment* — never from the mini-id (which is what
 * disambiguates) or from the pattern surround (which is what users grep for).
 *
 * Pure function.
 *
 * @example
 * buildBranchName({ pattern: "preview-*", miniId: "a1b2c3" })
 *   // → "preview-a1b2c3"
 * buildBranchName({ pattern: "preview-*", gitBranch: "andre-feature", miniId: "a1b2c3" })
 *   // → "preview-andre-feature-a1b2c3"
 */
export function buildBranchName(input: BuildBranchNameInput): string {
	const suffix = input.gitBranch
		? `${input.gitBranch}-${input.miniId}`
		: input.miniId;
	const full = fillPattern(input.pattern, suffix);
	if (full.length <= MAX_BRANCH_NAME_LENGTH) return full;

	// Over-long names happen when the git branch is unusually verbose. Trim *only* the
	// git fragment so the pattern surround and the mini-id (the disambiguator) survive.
	const overflow = full.length - MAX_BRANCH_NAME_LENGTH;
	if (!input.gitBranch || overflow >= input.gitBranch.length) {
		// Even fully removing the git fragment isn't enough. Fall back to the no-git form.
		return fillPattern(input.pattern, input.miniId);
	}
	const trimmedGit = input.gitBranch
		.slice(0, input.gitBranch.length - overflow)
		.replace(/-+$/, "");
	const trimmedSuffix = trimmedGit
		? `${trimmedGit}-${input.miniId}`
		: input.miniId;
	return fillPattern(input.pattern, trimmedSuffix);
}
