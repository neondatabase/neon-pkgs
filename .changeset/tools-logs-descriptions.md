---
"@neon/tools": patch
---

`query_logs` now notes that Neon Auth records include the end user's IP address, user agent, and user ID, and asks agents not to echo them unless the user asks. `update_auth_logs_export` now says it is Managed Better Auth only and in beta, and says which enable errors to wait on and retry once.
