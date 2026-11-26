---
"neon": minor
---

Project-scoped API keys now work wherever the CLI used to list projects. `neon me` shows the project the key is limited to (`project_id` in JSON), `neon projects list` lists that project, and `neon link -y`, `neon init -y`, and commands run outside a linked directory use it. `neon link -y` or `neon init -y` with `--project-name` now says the key cannot create projects, instead of reporting the organization as not found.
