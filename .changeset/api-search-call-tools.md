---
"@neon/tools": minor
---

Add `api.search` (`search_api`), which finds Neon API endpoints and their fields, and `api.call` (`call_api`), which sends one request to any Neon API path. `api.call` is not read-only safe, is withheld under `secrets: "none"`, and refuses Neon Auth routes under `secrets: "setup"`.
