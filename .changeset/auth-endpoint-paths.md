---
"@neon/auth": patch
---

Fix the server toolkit's `revokeOtherSessions` and `emailOtp.resetPassword` endpoint paths, which pointed at routes Neon Auth does not serve (`revoke-all-sessions`, `email-otp/passcode`). Remove the unused `jwks` endpoint entry.
