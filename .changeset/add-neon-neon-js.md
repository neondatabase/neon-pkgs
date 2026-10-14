---
"@neon/neon-js": patch
---

Add `@neon/neon-js`, migrated from `neondatabase/neon-js` (previously published as `@neondatabase/neon-js`) — a unified client combining Neon Auth and the Neon Data API. Versioning continues from the last `@neondatabase/neon-js` release (`0.8.0-beta`), so this first release publishes as `0.8.0`.

It depends on `@neon/auth` and `@neon/postgrest-js` only. Not carried over onto the new package name:

- the `neon-js` CLI and `gen-types` command (`bin`, `./cli`) — type generation moves to the `neon` CLI;
- the deprecated `auth/react/ui`, `auth/react/ui/server`, `ui/css` and `ui/tailwind` compatibility re-exports for `@neondatabase/auth-ui` — install and import from `@neondatabase/auth-ui` directly.

The string-form `createClient(baseUrl, { auth: { adapter } })` overloads now accept the adapter builder (`SupabaseAuthAdapter()`, `BetterAuthReactAdapter()`, …) as documented; they previously required an adapter instance, so an explicit adapter could not be passed.
