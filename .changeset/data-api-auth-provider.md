---
"@neon/tools": patch
---

`postgres.dataApi.create` (`provision_neon_data_api` on the Neon MCP server) now tells agents to pass `auth_provider: "neon_auth"` and `add_default_grants` when no provider is configured and the user has none of their own. Before reporting success, agents enable RLS on exposed tables or tell the user which lack it, and confirm Neon Auth has a JWKS URL, enabling it with `auth.create` when it doesn't. The `add_default_grants` input says every signed-in user can then read and write tables without RLS, and that signed-in requests get HTTP 403 without grants; `auth_provider` says requests fail with HTTP 401 without a JWT verifier.
