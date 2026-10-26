---
"@neon/neon-js": minor
---

Add `@neon/neon-js`, migrated from `neondatabase/neon-js` (previously published as `@neondatabase/neon-js`) — a unified client combining Neon Auth and the Neon Data API. This first release publishes as `0.10.0`, one minor version above the last `@neondatabase/neon-js` release (`0.9.0-beta`).

It depends on `@neon/auth` and `@neon/postgrest-js` only. Not carried over onto the new package name:

- the `neon-js` CLI and `gen-types` command (`bin`, `./cli`) — type generation moves to the `neon` CLI;
- the deprecated `auth/react/ui`, `auth/react/ui/server`, `ui/css` and `ui/tailwind` compatibility re-exports for `@neondatabase/auth-ui` — use `@better-auth-ui/react` or `@better-auth-ui/heroui` instead.

The string-form `createClient(baseUrl, { auth: { adapter } })` overloads now accept the adapter builder (`BetterAuthVanillaAdapter()`, `BetterAuthReactAdapter()`) as documented; they previously required an adapter instance, so an explicit adapter could not be passed.
