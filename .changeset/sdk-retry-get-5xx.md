---
"@neon/sdk": patch
---

A `GET` that answers `500` or `502` is now retried like a `503`, and so is the operation poll after a mutation, so a transient API error no longer fails a create or update that the API already accepted. Mutations are still never resent after a `500` or `502`.
