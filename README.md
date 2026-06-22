# Neon JavaScript Packages

[Neon](https://neon.com) open-source packages for the JavaScript/Typescript ecosystem.

| Package Name                   | Description                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `neon-init`                    | Set up your project with Neon's MCP Server for AI-powered database operations.                                       |
| `neon-new`                     | A CLI tool and SDK for creating claimable Neon databases instantly.                                                  |
| `vite-plugin-neon-new`         | A Vite plugin that automatically provisions databases during development.                                            |
| `@neondatabase/config`         | Config-as-Code for Neon: `defineConfig` types + the pure diff engine and Neon API adapter behind a `neon.ts` policy. |
| `@neondatabase/config-runtime` | Runtime for `neon.ts` policies — `inspect` / `plan` / `apply` (push/pull) plus function bundling and deploy.         |
| `@neondatabase/env`            | Resolve and inject a branch's Neon env (`fetchEnv` / `parseEnv`, `neon-env run`) from a `neon.ts` policy.            |
| `@neondatabase/ai-sdk-provider`| Community [Vercel AI SDK](https://ai-sdk.dev) provider for the Neon AI Gateway.                                       |
| `@neondatabase/functions`      | Runtime helpers for Neon Functions (e.g. a `waitUntil` primitive for deferring work past a response).                |

Each package's own `README` is the source of truth for its status — deprecated packages carry a deprecation banner at the top of theirs. A few renamed packages are still published as deprecated aliases (`get-db` / `neondb` → `neon-new`; `vite-plugin-db` / `@neondatabase/vite-plugin-postgres` → `vite-plugin-neon-new`); they re-export the new package and print a deprecation warning.

Every package under this repository is licensed under **Apache-2.0**.
