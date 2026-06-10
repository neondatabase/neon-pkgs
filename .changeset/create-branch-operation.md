---
"@neondatabase/config-runtime": minor
---

Add a `createBranch` operation that provisions a branch from a `neon.ts` policy.

`apply` always evaluated the policy as an *existing* branch (`exists: true`), so a policy that
gates creation-time tuning on `!branch.exists` (TTL, compute settings, `parent`) never applied
it when a branch was first created — e.g. `neonctl checkout <new-name>`, which created a bare
branch and then `apply`'d it. New `createBranch(config, { projectId, branchName })`:

1. evaluates the policy with `exists: false`,
2. creates the branch from the policy's `parent` (falling back to the project default), and
3. reconciles the rest (TTL, compute, `protected`, Neon Auth, Data API, functions) onto it.

Also adds a `branchExists?: boolean` option to `pushConfig` (defaults to `true`) that controls
the `branch.exists` value passed to the policy — the mechanism `createBranch` uses to apply as
a new branch.
