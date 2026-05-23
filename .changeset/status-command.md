---
"@neondatabase/platform": minor
---

Add `neon-ts status` — a read-only `terraform plan`-style diff of your local `neon.ts` against the live Neon project. Shows every branch / endpoint / project mutation that a real `neon-ts push` would apply, lists wildcard branches that would be skipped without `--apply-existing`, and surfaces hard conflicts (region drift, etc.) that would block the push entirely. Safe to run from pre-push hooks, CI, or just to check whether your local config has drifted — never calls a mutating API method.

On the SDK side, the same flow is available as `pushConfig({ dryRun: true })`:

```ts
const preview = await pushConfig(config, { dryRun: true });
// preview.dryRun  === true
// preview.applied        — what a real push would apply (no API mutations performed)
// preview.conflicts      — what would block a real push
// preview.skippedWildcardBranches
```

`PushResult` gains a `dryRun: boolean` field. Brand-new projects in dry-run mode get a `projectId` sentinel of `"<would-create>"` plus a synthetic root branch in the diff so `staging`-style child branches resolve their parent reference cleanly.
