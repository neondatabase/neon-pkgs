---
"neon": patch
---

Project-scoped commands run without `--project-id` (and without a project in `.neon`) no longer pick a project from the API key's default organization when you belong to several organizations. They now fail and ask for `--project-id` or `--org-id`, so commands like `neon roles create` can't act on a project you didn't mean.
