---
"neon": minor
"neonctl": minor
---

`neon init -y` / `neon bootstrap --default`, `neon skills -y`, `neon plugins -y`, and `neon mcp -y` install into detected agents: project folders (or installed apps with `--global` / default `mcp -y`), else the host CLI agent. `--agent <name>` on `skills`, `plugins`, and `mcp` names coding agents and skips detection. If `-y` finds none, the command exits and names `--agent` as the fix. `init`, `link`, and `bootstrap` have no `--agent`.
