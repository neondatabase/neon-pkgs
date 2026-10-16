---
"@neon/auth": patch
---

Report which adapter is in use (`supabase`, `better-auth-vanilla`, or `better-auth-react`) in an `adapter` field of the `X-Neon-Client-Info` header, so Neon Auth can see how traffic splits across adapters. `@neon/neon-js` forwards the same value for the adapter passed to `createClient`.
