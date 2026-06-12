---
"neon-init": patch
---

Make project bootstrapping resilient to GitHub rate limits.

- `neon init` now delegates scaffolding to `npx -y neonctl@latest bootstrap`, so a stale globally-installed `neonctl` can't be picked up — users always get the version of the CLI that downloads templates via the codeload tarball (no `api.github.com` rate limit) rather than the old REST tree-walk that failed with "GitHub API rate limit exceeded".
- The template manifest is now fetched from neon.com first (CDN-backed, no GitHub rate limiting), falling back to the raw GitHub copy and then a built-in list.
- The built-in fallback list now includes all starters (hono, ai-sdk, mastra), so the picker stays complete even when every manifest source is unreachable.
