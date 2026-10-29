---
"@neon/auth": patch
---

Make `@neon/auth` work with Better Auth UI 1.7. Errors thrown for failed auth requests now also carry the raw Better Auth response as `error` (for example `error.error.code === "EMAIL_NOT_VERIFIED"`), so Better Auth UI shows localized messages and redirects to email verification; `error.error.status` carries the raw HTTP status, and `code` and `status` are unchanged. `auth.middleware()` now treats the Better Auth UI 1.7 auth views as public by default: `/auth/error`, `/auth/redirect`, `/auth/sign-out`, `/auth/accept-invitation`, and the password-reset, verify-email, magic-link, email-OTP, two-factor and phone-number views under `/auth`. If your app serves its own protected pages at any of these paths, they are now reachable while signed out. `/auth` itself and `/settings/*` stay protected. It also accepts a new `publicRoutes` option to make additional routes public; an empty, slash-only or non-`/`-prefixed entry throws when the middleware is created.
