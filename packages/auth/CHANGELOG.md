# @neon/auth

## 0.8.1

### Patch Changes

- d7fe270: `better-auth` is now a `~1.7.12` range instead of an exact pin, so apps that use `@better-auth-ui/*` resolve a single copy of `better-auth` without pins or overrides. The SDK still reports the bare floor version (`1.7.12`) to Neon Auth. `@better-auth/core` (`~1.7.12`), `@better-auth/utils` (`^0.5.0`) and `better-call` (`~1.4.4`) are declared as ranges so the `@better-auth/oauth-provider` peers resolve under strict-peer and Plug'n'Play installs while still deduping with `better-auth`'s own copies. Requires a Neon Auth server running `better-auth` 1.7.12 or later, so release only after that rollout. Adds `client/rotate-keys` to the recognised OAuth provider routes.
- cac2b65: Make `@neon/auth` work with Better Auth UI 1.7. Errors thrown for failed auth requests now also carry the raw Better Auth response as `error` (for example `error.error.code === "EMAIL_NOT_VERIFIED"`), so Better Auth UI shows localized messages and redirects to email verification; `error.error.status` carries the raw HTTP status, and `code` and `status` are unchanged. `auth.middleware()` now treats the Better Auth UI 1.7 auth views as public by default: `/auth/error`, `/auth/redirect`, `/auth/sign-out`, `/auth/accept-invitation`, and the password-reset, verify-email, magic-link, email-OTP, two-factor and phone-number views under `/auth`. If your app serves its own protected pages at any of these paths, they are now reachable while signed out. `/auth` itself and `/settings/*` stay protected. It also accepts a new `publicRoutes` option to make additional routes public; an empty, slash-only or non-`/`-prefixed entry throws when the middleware is created.

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
