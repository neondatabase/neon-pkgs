---
"neon": patch
---

Deep imports under `neon/dist/_shared/` no longer resolve — that directory is gone. It held
credential reading and the branch-credential mint/revoke logic, compiled in from the repo's
internal code, which the `./dist/*` wildcard made importable by accident;
`neon/dist/_shared/credentials.js` was reachable before this change. That code is now bundled
into `neon/dist/_chunks/`, which is blocked the same way. Everything else under `neon/dist/` is
unaffected, and none of it was ever a supported surface: the CLI's entry points are the `neon`
binary, `neon` and `neon/cli`.
