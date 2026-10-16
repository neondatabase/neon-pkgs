---
"@neon/neon-js": patch
---

The Supabase-compatible client moves to its own subpath: import `createClient` from `@neon/neon-js/supabase`, which has `SupabaseAuthAdapter` built in (no `adapter` option). The main `createClient` no longer has Supabase overloads, and `SupabaseAuthAdapter`, `SupabaseAuthAdapterInstance` and `SupabaseAuthAdapterOptions` are no longer exported from `@neon/neon-js`; `SupabaseAuthAdapter` stays available from `@neon/neon-js/auth/vanilla/adapters`.

```diff
- import { createClient, SupabaseAuthAdapter } from "@neon/neon-js";
+ import { createClient } from "@neon/neon-js/supabase";

  const client = createClient({
-   auth: { adapter: SupabaseAuthAdapter(), url },
+   auth: { url },
    dataApi: { url: dataApiUrl },
  });
```
