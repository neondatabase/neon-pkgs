---
"@neondatabase/config": patch
---

Fix `defineConfig` autocomplete for the nested `preview` (and `auth`/`dataApi`) fields.

Each field was typed as the bare generic type parameter (e.g. `preview?: Preview`), so editors
had no concrete shape to complete against in the object-literal position and showed
`{} | undefined` with no hints for `aiGateway` / `functions` / `buckets`. The fields are now
intersected with their concrete interfaces (`Preview & PreviewInput`, `Auth & ServiceToggleInput`,
`DataApi & ServiceToggleInput`), restoring full member autocomplete and inline docs while keeping
the `const` literal inference that types the `branch` closure's function slugs. Type-only change —
no runtime behavior change.
