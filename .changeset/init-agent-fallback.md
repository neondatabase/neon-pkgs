---
"neon": minor
"neonctl": minor
---

`neon init -y` / `neon bootstrap --default`, `neon skills -y`, `neon plugins -y`, and `neon mcp -y` install into detected agents: project folders (or installed apps with `--global` / default `mcp -y`), else the host CLI agent. `--agent <name>` on `skills`, `plugins`, `mcp`, `init`, and `bootstrap` names coding agents and skips agent selection. `init` and `bootstrap` pass `--agent` to plugins, or to skills and mcp, not both. If `skills` / `plugins` / `mcp` `-y` finds none, the command names `--agent`. `link` has no `--agent`.
