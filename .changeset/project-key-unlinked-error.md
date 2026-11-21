---
"neon": patch
---

Project commands run outside a linked directory with a project-scoped API key now say that no project is linked and suggest running from the linked directory or passing `--project-id`. They previously printed only the API's "not allowed to perform actions outside the project this key is scoped to" error.
