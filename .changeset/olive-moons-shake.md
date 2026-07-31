---
"@neon/sdk": minor
---

Add a `userAgent` option so applications built on the SDK can identify themselves.

Neon attributes API traffic to a caller by user agent, but the SDK sent none and its config exposed no way to set one, so every SDK-backed tool was indistinguishable from a direct API call. `createNeonClient({ apiKey, userAgent: "my-cli/1.2.0" })` now sets the header on every request the client makes, including raw calls that reuse `neon.client`. Unset by default, so nothing changes for existing callers.
