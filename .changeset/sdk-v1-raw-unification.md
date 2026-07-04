---
"@neon/sdk": major
---

v1.0.0 — unify the raw layer on the ergonomic result contract, and wrap the high-value
auth/permissions surface.

**Raw layer (breaking).** Every `raw.*` operation (and `@neon/sdk/raw`) now speaks the same
contract as `createNeonClient`: it resolves to a `{ data, error }` `NeonResult` by default,
or the bare resource when you pass `throwOnError: true` (throwing the typed `NeonError`
hierarchy). The hey-api `{ data, request, response }` envelope and the `responseStyle`
switch have been removed from the public raw surface — `throwOnError` is the only switch and
the return type always tracks it. This fixes the two long-standing raw-layer papercuts:
`throwOnError` now really returns the bare resource, and the success type narrows correctly.

Migration: replace `const r = await raw.getProject({ …, throwOnError: true, responseStyle: "data" })`
with `const project = await raw.getProject({ …, throwOnError: true })`, and drop any
`unwrapRaw`/`responseStyle` workarounds. Default (non-throwing) calls now return
`{ data, error }` with a typed `NeonError` instead of the raw `GeneralError` envelope.

**New ergonomic namespaces.** `neon.auth` (branch-scoped Neon Auth: `get`/`create`/`disable`/
`updateConfig`, plus `auth.oauthProviders`, `auth.trustedDomains`, `auth.users`),
`neon.projects.permissions` (`list`/`grant`/`revoke`), `neon.projects.recover`, and
`neon.postgres.endpoints.listByBranch`.
