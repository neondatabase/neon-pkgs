# @neondatabase/platform

Branch-scoped config-as-code for the Neon Platform. A repo-local `neon.ts` exports a TypeScript policy function. The current branch is resolved from `--branch`, `NEON_BRANCH_ID`, or `.neon[/project.json]`; `push` evaluates the policy for that branch and applies only that branch's desired state.

> The end-user CLI surface will live in `neonctl` as `neonctl platform ...`. This package also ships `neon-ts` so the SDK and command behavior can be exercised before the neonctl integration lands.

## Install

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
      auth: { enabled: true },
      dataApi: { enabled: true },
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
    auth: { enabled: true },
  };
});
```

Project identity is not stored in `neon.ts`. Bootstrap or select the project with `neonctl link`; branch identity comes from `checkout`, `branch`, `--branch`, `NEON_BRANCH_ID`, or `.neon`.

```bash
# Create a starter neon.ts from the linked project's selected/default branch.
neon-ts init

# Select an existing branch by name or id. No creation, no config apply.
neon-ts checkout main

# Create a new branch. `dev` becomes the creation pattern `dev-*`.
neon-ts branch dev

# Show what push would do for the selected branch.
neon-ts status

# Apply the selected branch's policy. Mutable branch drift needs --update-existing.
neon-ts push --update-existing

# Pull branch-specific connection strings.
neon-ts env pull
neon-ts env run -- pnpm dev
```

## Mental Model

- `defineConfig((branch) => ...)` is a branch policy function. It can use normal TypeScript control flow: `branch.name`, `branch.exists`, `branch.isDefault`, `branch.isProtected`, env vars, shared constants, helper functions, etc.
- `checkout <branch>` selects an existing branch and updates `.neon[/project.json]` with its `branchId`.
- `branch <name>` always creates a new branch. If `<name>` has no `*`, the CLI treats it as `<name>-*` and substitutes the wildcard with `<git-branch>-<mini-id>` or `<mini-id>`.
- `push` is scoped to the selected branch. It does not create projects or branches.
- `pull` is inspection, not round-trip code generation. It prints the selected branch's remote state as JSON for copy/paste.
- `init` is the file-creation command. It creates a starter `neon.ts` from the selected/default branch.

## Branch Config Shape

```ts
type BranchConfig = {
  parent?: string;        // used when creating a new branch
  ttl?: string | number;  // applied on create, reconciled on push with --update-existing
  protected?: boolean;    // branch-level protected flag

  postgres?: {
    computeSettings?: {
      autoscalingLimitMinCu?: 0.25 | 0.5 | 1 | 2 | 4 | 8;
      autoscalingLimitMaxCu?: 0.25 | 0.5 | 1 | 2 | 4 | 8;
      suspendTimeout?: false | string | number;
    };
  };

  auth?: { enabled?: boolean };
  dataApi?: { enabled?: boolean };
};
```

`parent` and `ttl` are branch lifecycle fields, not Postgres fields. Product-specific settings live under product namespaces such as `postgres`, `auth`, and `dataApi`.

## Commands

```bash
neon-ts init                    # write ./neon.ts starter policy
neon-ts pull                    # print selected branch state as JSON
neon-ts checkout main           # select existing branch
neon-ts branch dev              # create dev-<git-branch>-<mini-id>
neon-ts status                  # dry-run push for selected branch
neon-ts push --update-existing  # apply mutable drift for selected branch
neon-ts context                 # print resolved project + branch context
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
  branch,
  checkout,
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
- `checkout` never creates or mutates remote resources.
- `branch` always creates a new branch and then updates local context.
- `auth.enabled: false`, `dataApi.enabled: false`, or absence leaves existing integrations alone. Disabling is destructive and remains explicit/manual.
- Mutable branch drift (`protected`, `ttl`, `postgres.computeSettings`) requires `--update-existing` outside dry-run status.
