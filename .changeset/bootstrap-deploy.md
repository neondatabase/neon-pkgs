---
"neon": minor
---

`neon bootstrap` can deploy the template once it is installed and linked. In a terminal, it asks "Deploy this project to Neon now?" when every env var the template's `neon.ts` reads is set; otherwise the done summary names the vars to set before `neon deploy --env .env.local`. `--deploy` deploys without asking.
