---
"@neondatabase/config": patch
---

Fix `defineConfig` autocomplete **inside** the nested `preview.functions` / `preview.buckets` slug objects.

The top-level `preview` fix (`Preview & PreviewInput`) restored hints for `aiGateway` / `functions` / `buckets`, but one level deeper editors still offered nothing inside a slug's value (e.g. `functions: { hello: { /* no name/source/env/dev hints */ } }`, and `buckets: { uploads: { /* no access hint */ } }`). `PreviewInput` types those records with a string index signature (`Record<string, FunctionDef>` / `Record<string, BucketDef>`), and once `defineConfig` infers `const Preview`, each authored slug becomes a *named* property on the inferred literal — a named property shadows the index signature when the editor computes the contextual type of that slug's value, so the rest of `FunctionDef` / `BucketDef` never surfaced.

`defineConfig` now also intersects `preview` with `PreviewAutocomplete<Preview>`, which re-declares each inferred slug's value as `FunctionDef` / `BucketDef` (a *named* member, via a mapped type over the already-inferred keys). This puts those members back on the contextual type without going through the index signature, restoring full autocomplete and inline docs inside each function/bucket object. Type-only change — it does not widen what is accepted, change the inferred `const Preview`, or affect runtime behavior.
