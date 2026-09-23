---
"@neon/auth": minor
---

Add `@neon/auth`, migrated from `neondatabase/neon-js` (previously `@neondatabase/auth`) — Supabase-compatible and Better Auth adapters for Neon Auth, with React, Next.js, and a framework-agnostic server toolkit (`@neon/auth/server`; see `BUILDING-AN-ADAPTER.md`).

The deprecated `react/ui` / `ui/*` compatibility re-exports for `@neondatabase/auth-ui` are not carried over onto the new package name — install and import from `@neondatabase/auth-ui` directly. `neon-auth-codemod` still ships as a bin for migrating those imports off an older `@neondatabase/auth` release.
