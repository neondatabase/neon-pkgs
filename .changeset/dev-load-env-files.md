---
"neon": minor
---

`neon dev` loads the project's `.env`, then `.env.local`, which overrides it, into the environment before evaluating `neon.ts`, so Function env values such as `process.env.DISCORD_PUBLIC_KEY!` resolve locally. Variables already set in the shell win. `neon dev --env <file>` loads only that file, like `neon deploy --env`.
