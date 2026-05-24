---
"@neondatabase/platform": minor
---

Add `neon-ts status` — a read-only `terraform plan`-style diff of your local `neon.ts` against the live Neon project. Shows every branch / endpoint / project mutation that a real `neon-ts push` would apply and surfaces hard conflicts (region drift, etc.) that would block the push entirely. Safe to run from pre-push hooks, CI, or just to check whether your local config has drifted — never calls a mutating API method.

On the SDK side, the same flow is available as `pushConfig({ dryRun: true })`:

```ts
const preview = await pushConfig(config, { dryRun: true });
// preview.dryRun  === true
// preview.applied        — what a real push would apply (no API mutations performed)
// preview.conflicts      — what would block a real push
```

`PushResult` gains a `dryRun: boolean` field. `pushConfig` requires an existing linked project; run `npx neonctl link`, pass `projectId`, set `NEON_PROJECT_ID`, or commit `.neon/project.json` before using `push` or `status`.
