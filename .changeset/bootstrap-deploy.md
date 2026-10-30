---
"neon": minor
---

`neon bootstrap --deploy` deploys a template into a new Neon project in one command. After scaffolding it installs dependencies, creates and links a new project (`--project-name`, `--region-id`, `--org-id`), writes the template's inputs from its `template.json` to `.env.local` (from `--env KEY=VALUE`, generated tokens, or defaults), and applies its `neon.ts` as `neon deploy --env .env.local` would. A failing `deploy.after` hook fails the command, because there the hook finishes setting up the template (for example, running migrations).

`--deploy` is staging-only for now. Outside `NEON_API_HOST` / `--api-host` pointing at `https://console-stage.neon.build/api/v2`, it and its flags are hidden from `neon bootstrap --help`, and passing it fails with "Deploying templates with `neon bootstrap --deploy` is coming soon!".
