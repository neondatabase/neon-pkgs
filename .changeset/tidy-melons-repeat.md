---
"neon": patch
---

Deep imports under `neon/dist/_shared/` no longer resolve. That directory holds source compiled in from the repo's shared trees — credential reading, and the branch-credential mint/revoke logic — which the `./dist/*` wildcard made importable by accident. `neon/dist/_shared/credentials.js` was reachable before this change. Everything else under `neon/dist/` is unaffected, and none of it was ever a supported surface: the CLI's entry points are the `neon` binary, `neon` and `neon/cli`.
