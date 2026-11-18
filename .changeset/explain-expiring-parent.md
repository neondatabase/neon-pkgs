---
"@neon/sdk": patch
---

When `branches.create` or `branches.createAndConnect` is refused because the parent branch has an expiration date, `error.message` now names the parent and says how to proceed: branch from a parent without an expiration date, or remove the parent's expiration (`expires_at: null`) after the user agrees. The message ends with the API's own text, which `body.message` still holds verbatim; `status`, `code`, and `requestId` are unchanged.
