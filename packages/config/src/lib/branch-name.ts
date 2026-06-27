/**
 * Derive a valid, stable Neon branch name from an arbitrary string (typically a git branch
 * name). Pure and dependency-free so it can be used both inside a `neon.ts` `checkout.before`
 * hook and by the CLI's default git → Neon mapping — one source of truth for the convention.
 *
 * The mapping is intentionally conservative and URL/shell-friendly:
 * - lowercased (by default);
 * - each path segment reduced to `[a-z0-9-]`, with runs of other characters collapsed to a
 *   single `-` and leading/trailing `-` trimmed;
 * - `/` preserved as a segment separator (by default), so a hierarchical git branch like
 *   `feature/billing-ui` round-trips to `feature/billing-ui` instead of being flattened;
 * - empty results fall back to `"branch"`;
 * - clamped to {@link ToNeonBranchNameOptions.maxLength}.
 *
 * @example toNeonBranchName("feature/PROJ-123 Add Billing")            // "feature/proj-123-add-billing"
 * @example toNeonBranchName("feature/x", { prefix: "preview/" })       // "preview/feature/x"
 * @example toNeonBranchName("Hotfix!!", { preserveSlashes: false })    // "hotfix"
 */
export interface ToNeonBranchNameOptions {
	/** Prepended to the input before sanitizing (e.g. `"preview/"`). */
	prefix?: string;
	/** Maximum length of the result. Default `256` (Neon's branch-name limit). */
	maxLength?: number;
	/** Lowercase the result. Default `true`. */
	lowercase?: boolean;
	/** Keep `/` as a segment separator. Default `true`. When `false`, slashes become `-`. */
	preserveSlashes?: boolean;
}

const DEFAULT_MAX_LENGTH = 256;
const FALLBACK_NAME = "branch";

/** Reduce one path segment to `[a-z0-9-]`, collapsing other runs to `-` and trimming `-`. */
function sanitizeSegment(segment: string): string {
	return segment
		.replace(/[^a-z0-9]+/gi, "-")
		.replace(/^-+/, "")
		.replace(/-+$/, "");
}

/**
 * Convert an arbitrary string into a valid Neon branch name. See {@link ToNeonBranchNameOptions}.
 */
export function toNeonBranchName(
	input: string,
	options: ToNeonBranchNameOptions = {},
): string {
	const lowercase = options.lowercase ?? true;
	const preserveSlashes = options.preserveSlashes ?? true;
	const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;

	let raw = `${options.prefix ?? ""}${input}`;
	if (lowercase) raw = raw.toLowerCase();

	const segments = preserveSlashes
		? raw.split("/")
		: [raw.replace(/\//g, "-")];
	const cleaned = segments
		.map(sanitizeSegment)
		.filter((segment) => segment.length > 0);

	const name = cleaned.join("/");
	// The fallback is a trusted constant and is returned as-is (not clamped): `maxLength`
	// bounds *derived* names, not the safety net for an empty derivation.
	if (name.length === 0) return FALLBACK_NAME;
	if (name.length > maxLength) {
		// Trim to the limit, then strip any separator the cut left dangling.
		const clamped = name.slice(0, maxLength).replace(/[-/]+$/, "");
		return clamped.length === 0 ? FALLBACK_NAME : clamped;
	}
	return name;
}
