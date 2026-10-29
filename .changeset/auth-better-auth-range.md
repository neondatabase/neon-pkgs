---
"@neon/auth": patch
---

`better-auth` is now a `~1.7.12` range instead of an exact pin, so apps that use `@better-auth-ui/*` resolve a single copy of `better-auth` without pins or overrides. The SDK still reports the bare floor version (`1.7.12`) to Neon Auth. `@better-auth/core` (`~1.7.12`), `@better-auth/utils` (`^0.5.0`) and `better-call` (`~1.4.4`) are declared as ranges so the `@better-auth/oauth-provider` peers resolve under strict-peer and Plug'n'Play installs while still deduping with `better-auth`'s own copies. Requires a Neon Auth server running `better-auth` 1.7.12 or later, so release only after that rollout. Adds `client/rotate-keys` to the recognised OAuth provider routes.
