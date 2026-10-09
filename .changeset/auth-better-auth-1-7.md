---
"@neon/auth": minor
---

Upgrade `better-auth` to 1.7.6 and adopt its account contract. Requires a Neon Auth server running better-auth 1.7.x; against an older server `getUserIdentities`, `unlinkIdentity` and the server toolkit's account calls fail.

- `accountId` now means the local account row id. `unlinkIdentity` sends only `{ accountId }`, and `getUserIdentities` queries `account-info` by the local id.
- `getUserIdentities` skips `account-info` for email/password (`credential`) accounts and returns an error when `account-info` fails for a social account, instead of logging a warning and returning partial identities. Social identities now populate `email`, `name`, `picture` and `email_verified` from the account-info `user` object.
- Requests carry a `betterAuthVersion` field in `X-Neon-Client-Info`, read from the exact `better-auth` pin, and the server toolkit and proxy forward the header. `BETTER_AUTH_VERSION` is exported from `@neon/auth`.
- `zod` moves to `^4.5.4`.
