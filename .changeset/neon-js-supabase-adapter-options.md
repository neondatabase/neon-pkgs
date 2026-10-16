---
"@neon/neon-js": patch
---

`createClient` from `@neon/neon-js/supabase` now accepts the `SupabaseAuthAdapter` options (`fetchOptions`, `sessionOptions`, ...) on its `auth` config, in both the object and string forms, so a server can forward a request cookie with `auth: { url, fetchOptions: { headers: { Cookie } } }`.
