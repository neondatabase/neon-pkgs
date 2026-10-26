# @neon/auth

## 0.8.0

### Minor Changes

- 5c41869: Add `@neon/auth`, migrated from `neondatabase/neon-js` (previously published as `@neondatabase/auth`) — Supabase-compatible and Better Auth adapters for Neon Auth, with React, Next.js, and a framework-agnostic server toolkit (`@neon/auth/server`; see `BUILDING-AN-ADAPTER.md`). Versioning continues from the last `@neondatabase/auth` release.

  The deprecated `react/ui` / `ui/*` compatibility re-exports for `@neondatabase/auth-ui` and the `neon-auth-codemod` bin are not carried over onto the new package name — install and import from `@neondatabase/auth-ui` directly.

- 8ac70da: Upgrade `better-auth` to 1.7.6 and adopt its account contract. Requires a Neon Auth server running better-auth 1.7.x; against an older server `getUserIdentities`, `unlinkIdentity` and the server toolkit's account calls fail.

  - `accountId` now means the local account row id. `unlinkIdentity` sends only `{ accountId }`, and `getUserIdentities` queries `account-info` by the local id.
  - `getUserIdentities` returns identities with Supabase field semantics: `identity_id` is the local account row id, `id` is the provider-side account id, and `user_id` is the owning user's id. Previously `id` and `identity_id` were swapped and `user_id` held the account row id. `unlinkIdentity` now accepts an identity exactly as `getUserIdentities` returned it.
  - `getUserIdentities` skips `account-info` for email/password (`credential`) accounts. When `account-info` fails for a social account (for example a Google account linked through `signInWithIdToken` without an `access_token`), it logs a warning and returns that identity with basic data only. Social identities now populate `email`, `name`, `picture` and `email_verified` from the account-info `user` object.
  - Requests carry a `betterAuthVersion` field in `X-Neon-Client-Info`, read from the exact `better-auth` pin, and the server toolkit and proxy forward the header. `BETTER_AUTH_VERSION` is exported from `@neon/auth`.
  - `zod` moves to `^4.5.4`.

- 1d6b3b4: Add the Better Auth OAuth provider client plugin, for the login and consent pages of a Neon Auth project acting as an OAuth provider (for example, for MCP clients). Every client from `createAuthClient()` exposes `oauth2.*`, and `createNeonAuth()` and `createAuthServer()` expose the user actions Neon routes: `consent`, `continue`, `publicClient`, `publicClientPrelogin`, `getConsent`, `getConsents`, `updateConsent` and `deleteConsent`. Requests to `/oauth2/*` paths, including `/oauth2/token`, are no longer answered from the session cache.

### Patch Changes

- 3ffbb4e: Report which adapter is in use (`supabase`, `better-auth-vanilla`, or `better-auth-react`) in an `adapter` field of the `X-Neon-Client-Info` header, so Neon Auth can see how traffic splits across adapters. `@neon/neon-js` forwards the same value for the adapter passed to `createClient`.
- de8f883: Fix server toolkit endpoints that Neon Auth rejected. `revokeOtherSessions` and `emailOtp.resetPassword` now request `revoke-other-sessions` and `email-otp/reset-password` (they requested `revoke-all-sessions` and `email-otp/passcode`), and `jwks` requests `/.well-known/jwks.json`. `verifyEmail` now uses `GET` with the token in the query string, and `admin.listUserSessions` and `organization.checkSlug` now use `POST`, matching Better Auth.
- fb321df: Fix the server toolkit's `getAccessToken`, which sent a `GET` to a route Neon Auth serves as `POST`, so the request body was dropped. Also omit the `Max-Age` attribute from forwarded cookies when the upstream value is not numeric instead of emitting `Max-Age=NaN`.
- 05d2c05: Send the `X-Neon-Client-Info` header on the middleware's get-session lookup and OAuth verifier exchange, so Neon Auth attributes that traffic to `@neon/auth` instead of an unknown SDK. An inbound `X-Neon-Client-Info` value is preserved.
