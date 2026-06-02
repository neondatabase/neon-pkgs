/**
 * Branch-name pattern helpers. Patterns are GitHub-branch-protection style globs:
 * `*` matches one or more characters within a name segment. `**` is not supported (branch
 * names cannot contain `/` in Neon).
 */

/** Returns `true` when the pattern contains an unescaped wildcard. */
export function isWildcardPattern(pattern: string): boolean {
	return pattern.includes("*");
}

/**
 * Returns `true` if `branchName` matches `pattern`. Anchors at both ends.
 */
export function matchPattern(pattern: string, branchName: string): boolean {
	const regex = patternToRegex(pattern);
	return regex.test(branchName);
}

/**
 * Substitute every `*` in `pattern` with `replacement`. When the pattern has no `*`, the
 * replacement is appended with a `-` separator so the caller still gets a unique name.
 *
 * Pure function. The returned string is **not** validated — callers compose it from
 * sources that already passed {@link validatePattern} (the pattern) and
 * {@link normalizeGitBranch}-style sanitization (the replacement).
 *
 * @example
 * fillPattern("preview-*", "andre-feature-a1b2c3") // → "preview-andre-feature-a1b2c3"
 * fillPattern("feat-*-staging", "x")               // → "feat-x-staging"
 * fillPattern("specific", "x")                     // → "specific-x"
 */
export function fillPattern(pattern: string, replacement: string): string {
	if (!isWildcardPattern(pattern)) return `${pattern}-${replacement}`;
	return pattern.replaceAll("*", replacement);
}

/**
 * Validate a branch pattern. Pure — returns either `{ ok: true }` or `{ error: string }`.
 *
 * Rules:
 * - Non-empty after trim, no leading/trailing whitespace.
 * - Length <= 256 (Neon branch name max).
 * - May contain `*`, ASCII letters/digits, and the punctuation Neon allows in branch names:
 *   `-`, `_`, `.`, `/`. Whitespace and regex meta-characters other than `*` are rejected.
 */
export function validatePattern(
	pattern: string,
): { ok: true } | { error: string } {
	const trimmed = pattern.trim();
	if (trimmed === "") return { error: "branch pattern is empty" };
	if (trimmed !== pattern) {
		return {
			error: `branch pattern has leading or trailing whitespace: ${JSON.stringify(pattern)}`,
		};
	}
	if (trimmed.length > 256) {
		return {
			error: `branch pattern exceeds 256 characters: ${trimmed.length} chars`,
		};
	}
	if (!/^[A-Za-z0-9._\-*/]+$/.test(trimmed)) {
		return {
			error: `branch pattern contains unsupported characters; allowed: letters, digits, '-', '_', '.', '/', '*' (got ${JSON.stringify(pattern)})`,
		};
	}
	return { ok: true };
}

function patternToRegex(pattern: string): RegExp {
	let body = "";
	for (const ch of pattern) {
		if (ch === "*") {
			body += ".*";
		} else if (REGEX_META.has(ch)) {
			body += `\\${ch}`;
		} else {
			body += ch;
		}
	}
	return new RegExp(`^${body}$`);
}

const REGEX_META = new Set([
	".",
	"+",
	"?",
	"^",
	"$",
	"(",
	")",
	"[",
	"]",
	"{",
	"}",
	"|",
	"\\",
]);
