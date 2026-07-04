---
"neonctl": patch
---

Adapt the API layer to `@neon/sdk@1.0.0`'s unified raw contract: raw calls now resolve to
`{ data, error }` with a typed `NeonError`, and the CLI unwraps the error body accordingly.
No user-facing behavior change.
