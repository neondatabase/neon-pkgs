---
"neon": minor
---

`neon bootstrap --deploy` deploys a template into a new Neon project in one command. After scaffolding it installs dependencies, creates and links a new project (`--project-name`, `--region-id`, `--org-id`), writes the template's inputs from its `template.json` to `.env.local` (from `--env KEY=VALUE`, generated tokens, or defaults), and applies its `neon.ts` as `neon deploy --env .env.local` would. A failing `deploy.after` hook fails the command, because there the hook finishes setting up the template (for example, running migrations).
