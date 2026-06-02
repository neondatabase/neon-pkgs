# @neondatabase/platform

Branch-scoped config-as-code for the Neon Platform. A repo-local `neon.ts` exports a TypeScript policy function. The current branch is resolved from `--branch`, `NEON_BRANCH_ID`, or `.neon[/project.json]`; `push` evaluates the policy for that branch and applies only that branch's desired state.

> The end-user CLI surface will live in `neonctl` as `neonctl platform ...`. This package also ships `neon-ts` so the SDK and command behavior can be exercised before the neonctl integration lands.

## Install

`neon-ts init` installs `@neondatabase/platform` automatically when your repo has a
`package.json`. It detects npm, pnpm, yarn, or bun from lockfiles (or the
`packageManager` field) and runs the matching add/install command before writing
`neon.ts`.

You can also add the package manually:

```bash
pnpm add @neondatabase/platform
# or
npm install @neondatabase/platform
```

Requires Node.js >= 22.

## Quick Start

Create `neon.ts` at the root of your repo:

```ts
import { defineConfig } from "@neondatabase/platform/v1";

export default defineConfig((branch) => {
  if (branch.name === "main") {
    return {
      protected: true,
      postgres: {
        computeSettings: {
          autoscalingLimitMinCu: 0.25,
          autoscalingLimitMaxCu: 2,
          suspendTimeout: "5m",
        },
      },
      auth: {},
      dataApi: {},
    };
  }

  return {
    parent: "main",
    ttl: "7d",
    postgres: {
      computeSettings: {
        autoscalingLimitMinCu: 0.25,
        autoscalingLimitMaxCu: 1,
        suspendTimeout: "5m",
      },
    },
    auth: {},
  };
});
```

Project identity is not stored in `neon.ts`. Bootstrap or select the project with `neonctl link`; branch identity comes from `neonctl checkout`, `--branch`, `NEON_BRANCH_ID`, or `.neon`.

```bash
# Install @neondatabase/platform (when needed) and create starter neon.ts.
neon-ts init

# Select an existing branch by name or id. No creation, no config apply.
# (Provided by the neonctl CLI; updates the same .neon context file.)
neonctl checkout main

# Show what push would do for the selected branch.
neon-ts status

# Apply the selected branch's policy. Push prompts before overriding existing
# settings or pushing to a protected branch; pass --update-existing /
# --allow-protected-branch to skip the prompt.
neon-ts push

# Pull branch-specific connection strings.
neon-ts env pull
neon-ts env run -- pnpm dev
```

## Mental Model

- `defineConfig((branch) => ...)` is a branch policy function. It can use normal TypeScript control flow: `branch.name`, `branch.exists`, `branch.isDefault`, `branch.isProtected`, env vars, shared constants, helper functions, etc.
- `neonctl checkout <branch>` (from the neonctl CLI) selects an existing branch and updates `.neon[/project.json]` with its `branchId`.
- `push` is scoped to the selected branch. It does not create projects or branches.
- `pull` is inspection, not round-trip code generation. It prints the selected branch's remote state as JSON for copy/paste.
- `init` installs `@neondatabase/platform` when it is missing, then creates a starter `neon.ts` from the selected/default branch. In monorepos it follows lockfiles up to the workspace root.

## Branch Config Shape

```ts
type BranchConfig = {
  parent?: string;        // used when creating a new branch
  ttl?: string | number;  // applied on create, reconciled on push (prompts to override)
  protected?: boolean;    // branch-level protected flag

  postgres?: {
    computeSettings?: {
      autoscalingLimitMinCu?: 0.25 | 0.5 | 1 | 2 | 4 | 8;
      autoscalingLimitMaxCu?: 0.25 | 0.5 | 1 | 2 | 4 | 8;
      suspendTimeout?: false | string | number;
    };
  };

  auth?: { enabled?: boolean };    // {} enables with defaults; enabled: false opts out
  dataApi?: { enabled?: boolean }; // {} enables with defaults; enabled: false opts out
};
```

`parent` and `ttl` are branch lifecycle fields, not Postgres fields. Product-specific settings live under product namespaces such as `postgres`, `auth`, and `dataApi`.

## Commands

```bash
neon-ts init                    # install package (if needed) and write ./neon.ts
neon-ts pull                    # print selected branch state as JSON
neonctl checkout main           # select existing branch (neonctl CLI)
neon-ts status                  # dry-run push for selected branch
neon-ts push                    # apply selected branch policy (interactive)
neon-ts push --update-existing  # auto-confirm overriding existing remote settings
neon-ts push --allow-protected-branch  # auto-confirm pushing to a protected branch
neon-ts env pull                # write .env.local
neon-ts env run -- pnpm test    # run a command with Neon env vars injected
```

Stable context precedence:

| Field | 1st | 2nd | 3rd |
| --- | --- | --- | --- |
| project | CLI/SDK option | `NEON_PROJECT_ID` | `.neon[/project.json].projectId` |
| branch | CLI/SDK option | `NEON_BRANCH_ID` | `.neon[/project.json].branchId` |
| org | CLI/SDK option | `NEON_ORG_ID` | `.neon[/project.json].orgId` |

## SDK Surface

```ts
import {
  defineConfig,
  pushConfig,
  pullConfig,
  fetchEnv,
  parseEnv,
  loadContext,
  loadConfigFromFile,
  createRealNeonApi,
  resolveApiKey,
  PlatformError,
  ErrorCode,
  errors,
  schemas,
} from "@neondatabase/platform/v1";
```

`pushConfig(config, { branch })` evaluates `config` for the selected branch, diffs branch resources against Neon, and applies planned mutations. `pushConfig({ dryRun: true, updateExisting: true })` powers `status`.

`fetchEnv(config)` and `parseEnv(config)` return a namespaced shape. `postgres` is always present; `auth` and `dataApi` are included when the evaluated branch policy enables them.

## Safety Rules

- `push` never creates projects or branches.
- `auth: {}` and `dataApi: {}` enable those integrations with Neon defaults. `auth.enabled: false`, `dataApi.enabled: false`, or absence leaves existing integrations alone. Disabling is destructive and remains explicit/manual.
- Mutable branch drift (`protected`, `ttl`, `postgres.computeSettings`) prompts for confirmation on the CLI; pass `--update-existing` to auto-confirm or supply a `confirm` callback to `pushConfig` programmatically.
- Pushing to a branch with the `protected` flag set on Neon prompts for confirmation; pass `--allow-protected-branch` to auto-confirm.
