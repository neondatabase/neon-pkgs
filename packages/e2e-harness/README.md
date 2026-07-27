# @neon/e2e-harness

Internal, **never published**. Shared plumbing for the live Neon e2e suites in
`@neon/sdk`, `@neon/config`, `@neon/config-runtime`, `@neon/env`, and `neonctl` — the
ones `pnpm test:e2e:live` runs against a real Neon organization.

It exists because that plumbing is dangerous to get wrong. Every suite creates real
projects and deletes them again, and cleanup is the part with teeth: a sweep that is
too eager deletes a concurrent run's project, and one that is too timid leaves
undeletable projects behind forever. Keeping a single implementation means those rules
are written down once.

## What it provides

| Export | Purpose |
| --- | --- |
| `loadEnv(dir)` | Read `.env` from the package, then the repo root; real env vars always win |
| `requireApiKey()`, `configuredOrgId()` | The `NEON_API_KEY` / `NEON_ORG_ID` contract |
| `detectApiKeyScope()` | Whether the key can create projects, or is pinned to one |
| `uniqueProjectName()`, `PROJECT_PREFIX`, `DEFAULT_REGION` | Naming that makes cleanup safe |
| `createProject()`, `deleteProject()` | Project lifecycle, org-scoped |
| `waitForProjectReady()` | Poll until no operation is still in flight |
| `sweepOrphans()` | Reclaim leftovers from previous failed runs |
| `e2eTest` | Vitest fixture with a `track(id)` cleanup hook |
| `installSuiteSetup()` | `beforeAll` that probes the key and sweeps |
| `apiRequest()`, `ApiError`, `statusOf()`, `describeError()`, `sleep()` | The `fetch` layer |

## It does not use `@neon/sdk`

Deliberately. `@neon/sdk` is one of the packages these suites test, and plumbing built on
the subject under test fails in the least useful way: a bug in the SDK would break both
the assertion *and* the teardown meant to clean up after it, leaving real projects behind
and turning one honest failure into a cascade. So the harness speaks to the Neon API with
plain `fetch` and has no runtime dependencies at all. It also keeps the workspace graph
acyclic, since `@neon/sdk` depends on this package for its own e2e suite.

## Cleanup rules

Three invariants, all enforced here rather than in each suite:

1. **Prefix guard.** `deleteProject` refuses any project not named `neon-ts-e2e-*`, so a
   mis-typed id can never reach an unrelated project.
2. **Age guard.** `sweepOrphans` ignores projects created in the last hour, so parallel
   CI runs sharing one org don't delete each other's work in progress.
3. **Unprotect before delete.** Neon rejects a delete with 422 while a branch is
   protected. Without clearing the flag the project is unreachable by *any* later
   cleanup, so it would sit in the org indefinitely.

A fourth rule governs setup rather than teardown: `createProject` **waits for the
project to be usable** before returning. "Created" and "usable" are different states —
Neon rejects the next mutation with "project already has running conflicting
operations" while provisioning is in flight — and a helper that hands back an id you
can't use yet just moves that race into every caller.

## Consuming it

Add `"@neon/e2e-harness": "workspace:*"` to the package's `devDependencies`, then in
`vitest.e2e.config.ts` point `setupFiles` at a local `e2e/load-env.ts` and
`e2e/setup.ts` that delegate here. See `packages/sdk/e2e/` for the smallest example.

It has no build step — consumers import the TypeScript source directly, which is why
`exports` points at `src/index.ts`.
