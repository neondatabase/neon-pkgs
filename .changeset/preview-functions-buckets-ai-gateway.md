---
"@neondatabase/config": minor
---

Add a `preview` block to the `neon.ts` branch policy for upcoming Neon Platform features, all backed by `x-stability-level: beta` endpoints:

- **`preview.functions`** — deploy worker/Vercel-style handlers (`export default { fetch }` or `export async function handler(req)`) from a `source` file path. Supports per-function `env` (validated as defined strings), `runtime` (`nodejs24`), `memoryMib`, and `concurrency`, with sane defaults.
- **`preview.buckets`** — branchable object-storage buckets, each `{ name, access?: "private" | "public_read" }` (defaults to `private`).
- **`preview.aiGateway`** — an `{ enabled }` toggle, mirroring the `auth` / `dataApi` semantics.

```ts
import { defineConfig } from "@neondatabase/config/v1";

export default defineConfig((branch) => ({
  preview: {
    functions: [
      {
        name: "Hello World",
        slug: "hello-world",
        source: "./functions/hello-world.ts",
        env: { RESEND_API_KEY: process.env.RESEND_API_KEY },
      },
    ],
    buckets: [{ name: "uploads", access: "public_read" }],
    aiGateway: { enabled: true },
  },
}));
```

Preview features are applied **additively** by `pushConfig` / `apply` (buckets and functions are created and the AI Gateway is enabled, but nothing is auto-deleted), and `pullConfig` / `inspect` reports the live preview state of a branch. Function bundling (esbuild + ZIP) is not implemented yet — deploys currently ship an empty bundle.
