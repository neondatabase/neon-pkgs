---
"@neon/config": minor
---

Add `nativePackages` to a `neon.ts` function definition, declaring packages backed by a
native binary whose real files should ship into the deployed archive alongside the bundle.
This is the schema and type surface only; the bundler change that acts on the list follows
separately. A package may not appear in both `nativePackages` and `externalPackages`, and
entries are package names without a subpath.
