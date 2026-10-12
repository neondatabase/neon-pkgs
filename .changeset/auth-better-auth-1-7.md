---
"@neon/auth": minor
---

Upgrade `better-auth` to 1.7.6 and adopt its account contract. Requires a Neon Auth server running better-auth 1.7.x; against an older server `getUserIdentities`, `unlinkIdentity` and the server toolkit's account calls fail.

- `accountId` now means the local account row id. `unlinkIdentity` sends only `{ accountId }`, and `getUserIdentities` queries `account-info` by the local id.
- `getUserIdentities` returns identities with Supabase field semantics: `identity_id` is the local account row id, `id` is the provider-side account id, and `user_id` is the owning user's id. Previously `id` and `identity_id` were swapped and `user_id` held the account row id. `unlinkIdentity` now accepts an identity exactly as `getUserIdentities` returned it.
- `getUserIdentities` skips `account-info` for email/password (`credential`) accounts. When `account-info` fails for a social account (for example a Google account linked through `signInWithIdToken` without an `access_token`), it logs a warning and returns that identity with basic data only. Social identities now populate `email`, `name`, `picture` and `email_verified` from the account-info `user` object.
- Requests carry a `betterAuthVersion` field in `X-Neon-Client-Info`, read from the exact `better-auth` pin, and the server toolkit and proxy forward the header. `BETTER_AUTH_VERSION` is exported from `@neon/auth`.
- `zod` moves to `^4.5.4`.
