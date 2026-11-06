---
"@neon/sdk": minor
---

Add `neon.logs.loki.queryRange`, `labels`, and `labelValues` for the branch's Loki-compatible read API. They return Loki's response bodies unchanged, with nanosecond timestamp strings and truncation `warnings`. API errors whose body carries a string `error` now use it as the error message.
