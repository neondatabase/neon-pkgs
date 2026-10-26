---
"@neon/auth": patch
---

Fix server toolkit endpoints that Neon Auth rejected. `revokeOtherSessions` and `emailOtp.resetPassword` now request `revoke-other-sessions` and `email-otp/reset-password` (they requested `revoke-all-sessions` and `email-otp/passcode`), and `jwks` requests `/.well-known/jwks.json`. `verifyEmail` now uses `GET` with the token in the query string, and `admin.listUserSessions` and `organization.checkSlug` now use `POST`, matching Better Auth.
