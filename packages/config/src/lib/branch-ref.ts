/**
 * A branch reference: either a Neon-issued id (e.g. `br-cool-snow-12345`) or a
 * human-readable branch name. We disambiguate solely on the `br-` prefix.
 *
 * Pure value type — no filesystem or environment access. Callers pass a branch
 * selector string and we classify it here.
 */
export type BranchRef =
	| { kind: "id"; value: string }
	| { kind: "name"; value: string };

/**
 * Classify a branch selector string as an id (`br-…` prefix) or a name. Trims whitespace;
 * throws nothing — empty input is classified as a (empty) name, which downstream lookups
 * will simply fail to match.
 */
export function classifyBranchRef(value: string): BranchRef {
	const trimmed = value.trim();
	if (/^br-[a-z0-9-]+$/i.test(trimmed)) {
		return { kind: "id", value: trimmed };
	}
	return { kind: "name", value: trimmed };
}
