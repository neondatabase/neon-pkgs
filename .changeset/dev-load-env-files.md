---
"neon": minor
---

`neon dev` loads the project's `.env.local` and `.env` into the environment before evaluating `neon.ts`, so Function env values such as `process.env.DISCORD_PUBLIC_KEY!` resolve locally. Variables already set win, then `.env.local`, then `.env`. `neon dev --env <file>` loads only that file, like `neon deploy --env`.
