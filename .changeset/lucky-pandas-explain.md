---
"@neon/sdk": minor
---

Make errors diagnosable in production builds.

- Error class names are now string literals rather than derived from the constructor, so they survive bundling. Previously every error surfaced as `s` or `r` in a minified consumer, which broke log reading and error-tracker grouping.
- `NeonNetworkError` gains a `reason` field carrying the most specific transport reason available (an `errno` code such as `ECONNRESET`, otherwise the innermost non-empty message), and interpolates it into `message`. A DNS failure, a reset connection, and a timeout no longer share one indistinguishable string.
- An empty, whitespace-only, or missing path parameter is now refused before the request is sent, with a `"client"` error naming the parameter. Such a value produces a path with an empty segment, which the Neon API redirects rather than rejecting, surfacing to the caller as an opaque network failure.
