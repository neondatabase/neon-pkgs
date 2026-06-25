---
"@neondatabase/config": patch
---

Migrate the real Neon API adapter (`createRealNeonApi`) from the deprecated `@neondatabase/api-client` (axios) to the new fetch-based `@neon/sdk` raw layer. The `NeonApi` façade and all behavior are unchanged — the standard project/branch/endpoint/role/database/data-api calls now go through `@neon/sdk/raw`, and a small `unwrap` helper re-throws non-2xx responses in the same shape the existing error wrapper and 423 retry already consume. This drops `@neondatabase/api-client` from the package's runtime dependencies in favor of the zero-dependency `@neon/sdk`.
