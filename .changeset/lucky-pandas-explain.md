---
"@neon/sdk": minor
---

Make errors diagnosable in production builds.

- Error class names are now string literals rather than derived from the constructor, so they survive bundling. Previously every error surfaced as `s` or `r` in a minified consumer, which broke log reading and error-tracker grouping.
- `NeonNetworkError` gains a `reason` field carrying the most specific transport reason available (an `errno` code such as `ECONNRESET`, otherwise the innermost non-empty message), and interpolates it into `message`. A DNS failure, a reset connection, and a timeout no longer share one indistinguishable string.
