---
"@neon/tools": patch
---

In `@neon/tools/effect`, a mistake a tool reports itself, such as a missing doc page or table, a missing extension, or a read-only refusal, keeps the `NeonTools.<id>` span ok instead of failing it.
