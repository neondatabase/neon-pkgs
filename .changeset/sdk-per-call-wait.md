---
"@neon/sdk": minor
---

`CallOptions` now accepts `wait: { pollIntervalMs?, timeoutMs? }`, so a single client can use a longer readiness budget on one `projects.create` without changing the rest. Client `wait` no longer accepts `signal`; pass `signal` on the call. `operations.waitFor` still takes top-level `pollIntervalMs`, `timeoutMs`, and `signal`.
