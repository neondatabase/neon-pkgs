---
"@neon/auth": minor
---

Add the Better Auth OAuth provider client plugin, for the login and consent pages of a Neon Auth project acting as an OAuth provider (for example, for MCP clients). Every client from `createAuthClient()` exposes `oauth2.*`, and `createNeonAuth()` and `createAuthServer()` expose the user actions Neon routes: `consent`, `continue`, `publicClient`, `publicClientPrelogin`, `getConsent`, `getConsents`, `updateConsent` and `deleteConsent`. Requests to `/oauth2/*` paths, including `/oauth2/token`, are no longer answered from the session cache.
