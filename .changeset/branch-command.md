---
"@neondatabase/platform": minor
---

Replace the static project/branches config shape with a branch-scoped TypeScript policy function:

```ts
export default defineConfig((branch) => ({
  parent: branch.name === "main" ? undefined : "main",
  postgres: { computeSettings: { autoscalingLimitMaxCu: 2 } },
  auth: { enabled: true },
}));
```

`push` is now scoped to the selected branch (`--branch`, `NEON_BRANCH_ID`, or `.neon[/project.json].branchId`) and applies only that branch's desired resources. Project identity stays in Neon context (`neonctl link`), not in `neon.ts`.

Add `checkout <branch>` for selecting an existing branch without creating anything, and make `branch <name>` always create a new branch from the policy (`dev` becomes `dev-*`, with the wildcard filled by git branch + mini id). `pull` now prints selected branch state as JSON for inspection/copy-paste, while `init` writes a starter `neon.ts` policy file.
