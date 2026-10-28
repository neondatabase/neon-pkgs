---
"neon": patch
---

`neon init` finishes project setup when the Neon plugin, skills, or MCP setup fails for an agent. It still links the project (or writes `.neon` offline from `--org-id`, `--project-id`, and `--branch`) and writes `neon.ts`, then reports the failed agent step with the command to retry and exits 1. Before, the first failed plugin install stopped init before `.neon` and `neon.ts` were written.
