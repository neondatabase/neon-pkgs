# Neon Branch IaC Examples

## What `.neon` Is For

`.neon` is local project context. It answers: "which Neon project and branch should commands operate on from this directory?"

```json
{
  "orgId": "org-...",
  "projectId": "proj-...",
  "branchId": "br-..."
}
```

`neonctl link` creates or updates this file. `checkout` and `branch` update the `branchId`.

## What `neon.ts` Is For

`neon.ts` is branch-scoped IaC. It describes what Neon should provision or reconcile for the selected branch.

Project identity does not live in `neon.ts`; it lives in `.neon`, env vars, or CLI flags.

## Commands

```bash
neonctl platform init              # create starter neon.ts
neonctl platform pull              # print selected branch state as JSON
neonctl platform checkout main     # select existing branch
neonctl platform branch            # create <git-branch>-<id>
neonctl platform branch dev        # create dev-<git-branch>-<id>
neonctl platform status            # dry-run push for selected branch
neonctl platform push              # apply selected branch IaC
neonctl platform env pull          # write selected branch env vars
neonctl platform env run -- pnpm test
```

## Example: Environment-Based Compute Settings

Use this when local/dev runs should use small scale-to-zero compute, while production deploys should use always-on compute.

```ts
import { defineConfig } from "@neondatabase/platform/v1";

const isDevelopment = process.env.NODE_ENV === "development";

export default defineConfig(() => {
  if (isDevelopment) {
    return {
      postgres: {
        computeSettings: {
          autoscalingLimitMinCu: 0.25,
          autoscalingLimitMaxCu: 1,
          suspendTimeout: "5m",
        },
      },
    };
  }

  return {
    postgres: {
      computeSettings: {
        autoscalingLimitMinCu: 2,
        autoscalingLimitMaxCu: 8,
        suspendTimeout: false,
      },
    },
  };
});
```

Note: the current SDK schema supports CU values up to `8`. If/when `16` CU is added to the schema, production can use `autoscalingLimitMaxCu: 16`.

## Example: Branch Pattern-Based IaC

Use this when `dev`, `preview`, and production branches need different Neon resources.

```ts
import { defineConfig } from "@neondatabase/platform/v1";

export default defineConfig((branch) => {
  if (branch.name.startsWith("dev-")) {
    return {
      parent: "prod",
      ttl: "7d",
      postgres: {
        computeSettings: {
          autoscalingLimitMinCu: 0.25,
          autoscalingLimitMaxCu: 1,
          suspendTimeout: "5m",
        },
      },
    };
  }

  if (branch.name.startsWith("preview-")) {
    return {
      parent: "prod",
      ttl: "1d",
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
    protected: true,
    postgres: {
      computeSettings: {
        autoscalingLimitMinCu: 2,
        autoscalingLimitMaxCu: 8,
        suspendTimeout: false,
      },
    },
    auth: { enabled: true },
    dataApi: { enabled: true },
  };
});
```

Example flow:

```bash
neonctl platform checkout prod
neonctl platform push --update-existing

neonctl platform branch dev
neonctl platform env pull
pnpm dev

neonctl platform branch preview
neonctl platform status
neonctl platform env run -- pnpm test
```

## Example: Auth + Data API With Default Compute

Use this when Neon default compute settings are enough and you only want to manage branch-scoped integrations.

```ts
import { defineConfig } from "@neondatabase/platform/v1";

export default defineConfig(() => {
  return {
    auth: { enabled: true },
    dataApi: { enabled: true },
  };
});
```

Because no `postgres.computeSettings` are specified, Neon default compute settings apply.
