---
"@neon/sdk": patch
---

Fix the published type declarations. Projects that type-check dependencies (no `skipLibCheck`) failed to compile on `raw.d.ts` (`Cannot find name 'raw_d_exports'`), and with `skipLibCheck` the `raw` namespace from `@neon/sdk` was typed as `any`. `raw` is now fully typed.
