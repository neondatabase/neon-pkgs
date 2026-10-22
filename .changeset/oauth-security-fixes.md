---
"@neon/oauth": patch
---

Fix: the MCP adapters (`expressMcp`, `nodeMcp`, `honoMcp`) now require a bearer token on every request routed to the MCP endpoint, including path variants (case, trailing slash, percent-encoding) and methods beyond POST/GET/DELETE; `OPTIONS` stays open for CORS preflight. `returnTo` on login and logout now only accepts same-origin paths. Custom MCP adapters should use the new `isGuardedMcpRequest` instead of comparing `MCP_METHODS` and the path themselves.
