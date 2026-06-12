---
"@neondatabase/config": minor
"@neondatabase/config-runtime": minor
---

Add a rich `dataApi` config to `neon.ts`: auth provider selection + reconcilable runtime settings.

`dataApi` still accepts the boolean/toggle forms (`true` / `{}` / `{ enabled: true }`), but now also takes an object describing the integration:

```ts
defineConfig({
  auth: true,
  dataApi: {
    authProvider: "neon", // default; "external" verifies a third-party IdP
    settings: { dbSchemas: ["public", "api"], dbMaxRows: 1000 },
  },
});
```

- **`authProvider`** is `"neon"` (default) or `"external"` (friendly values, mapped to the API's `neon_auth` / `external`). The external-IdP wiring (`jwksUrl`, `providerName`, `jwtAudience`) is only valid — and only typeable — on the `"external"` variant (the `"neon"` variant types those fields as `never`).
- **`settings`** mirror the Neon API `DataAPISettings` in camelCase (`dbAggregatesEnabled`, `dbAnonRole`, `dbExtraSearchPath`, `dbMaxRows`, `dbSchemas`, `jwtRoleClaimKey`, `jwtCacheMaxLifetime`, `openapiMode`, `serverCorsAllowedOrigins`, `serverTimingEnabled`).
- **A `"neon"` Data API requires Neon Auth.** Enforced both at author time (TypeScript makes `auth` required) and at runtime (zod cross-field check). An `"external"` Data API does not.
- The auth wiring is set when the Data API is first **enabled** (carried on the create request) and is immutable afterward. Changing the runtime `settings` is reconciled as an **update** and requires `updateExisting` / `--update-existing`, like compute/TTL/`protected` drift.

The `add_default_grants` / `skip_auth_schema` create-only flags are intentionally not exposed.
