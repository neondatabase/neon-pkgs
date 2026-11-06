---
"neon": patch
---

`neon config apply`, `neon deploy`, and `neon checkout` no longer refuse a `neon.ts` that enables the AI Gateway on the Free plan; the gateway credentials are pulled like every other service. When the account can't serve any model yet, `neon env pull` warns with the gateway's reason and the Console page that fixes it, such as buying AI Gateway credits.
