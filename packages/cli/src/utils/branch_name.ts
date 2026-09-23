const MAX_LENGTH = 256;
const FALLBACK_NAME = 'branch';

/** Reduce one path segment to `[a-z0-9-]`, collapsing other runs to `-` and trimming `-`. */
const sanitizeSegment = (segment: string): string =>
  segment
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

/**
 * Convert a git branch name into a valid, stable Neon branch name — lowercased, each
 * `/`-separated segment reduced to `[a-z0-9-]` (runs of other characters collapsed to a
 * single `-`, leading/trailing `-` trimmed), `/` preserved as a segment separator so a
 * hierarchical branch like `feature/billing-ui` round-trips unchanged, empty results fall
 * back to `"branch"`, and the result is clamped to 256 characters (Neon's branch-name
 * limit). This is the computation behind `GitContext.neonSafeBranchName` (from
 * `@neondatabase/config`) — call it directly only where you don't already have a
 * `GitContext` (e.g. `git sync` deriving the default Neon branch name for the current git
 * branch).
 *
 * @example neonSafeBranchName("feature/PROJ-123 Add Billing") // "feature/proj-123-add-billing"
 * @example neonSafeBranchName("Hotfix!!") // "hotfix"
 */
export const neonSafeBranchName = (gitBranch: string): string => {
  const cleaned = gitBranch
    .toLowerCase()
    .split('/')
    .map(sanitizeSegment)
    .filter((segment) => segment.length > 0);

  const name = cleaned.join('/');
  // The fallback is a trusted constant and is returned as-is (not clamped): `MAX_LENGTH`
  // bounds *derived* names, not the safety net for an empty derivation.
  if (name.length === 0) return FALLBACK_NAME;
  if (name.length > MAX_LENGTH) {
    // Trim to the limit, then strip any separator the cut left dangling.
    const clamped = name.slice(0, MAX_LENGTH).replace(/[-/]+$/, '');
    return clamped.length === 0 ? FALLBACK_NAME : clamped;
  }
  return name;
};
