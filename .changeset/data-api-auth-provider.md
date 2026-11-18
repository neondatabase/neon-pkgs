---
"@neon/tools": patch
---

`postgres.dataApi.create` (`provision_neon_data_api` on the Neon MCP server) now tells agents to pass `auth_provider: "neon_auth"` and `add_default_grants` when no provider is configured and the user has none of their own, and to confirm Neon Auth has a JWKS URL, enabling it with `auth.create` when it doesn't, before reporting success. Its `auth_provider` and `add_default_grants` inputs say that requests fail with HTTP 401 without a JWT verifier and HTTP 403 without grants.
