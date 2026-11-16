---
"@neon/sdk": patch
"@neon/tools": patch
---

`neon.snapshots.restore` and the `restore_snapshot` tool no longer finalize by default. Without `targetBranchId`, the API restores onto the snapshot's source branch, so the old default replaced that branch (often production) with the snapshot's data. A restore now stays a separate branch unless you pass `finalize: true`:

```ts
await neon.snapshots.restore({ projectId, snapshotId, finalize: true });
```

The tool descriptions now say that finalize replaces the target branch, and both `restore_snapshot` and `finalize_branch_restore` tell agents to ask the user first.
