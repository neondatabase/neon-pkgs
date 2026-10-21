---
"neon": minor
"neonctl": minor
---

Add `neon functions new [template]` and `neon functions templates list`. Templates come from the Neon Function Registry (`registry/` in neondatabase/examples): the index is read from neon.com, falling back to GitHub, and template files are read from GitHub. The scaffolded functions are declared in `neon.ts`. Set `NEON_FUNCTION_REGISTRY_DIR` to use a local copy, or `NEON_FUNCTION_REGISTRY_URL` to use another index.
