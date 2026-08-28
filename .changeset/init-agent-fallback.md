---
"neon": minor
"neonctl": minor
---

`neon init -y` / `neon bootstrap --default`, `neon skills -y`, `neon plugins -y`, and `neon mcp -y` install into detected agents: project folders (or installed apps with `--global` / default `mcp -y`), else the host CLI agent. If none are found, the command exits and names how to fix it. Non-interactive runs pass that command's flags (`--project-id`, `--skill`, `--global`, `--oauth`, `--project`, …).
