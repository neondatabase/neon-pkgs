---
"@neon/auth": patch
---

Make `@neon/auth` work with Better Auth UI 1.7. Errors thrown for failed auth requests now also carry the raw Better Auth response as `error` (for example `error.error.code === "EMAIL_NOT_VERIFIED"`), so Better Auth UI shows localized messages and redirects to email verification; `code` and `status` are unchanged. `auth.middleware()` now lets signed-out users open the password-reset, verify-email, magic-link-sent, error, redirect, sign-out and invitation pages, and accepts a new `publicRoutes` option to make additional routes public.
