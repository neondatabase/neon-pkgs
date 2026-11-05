---
"neon": patch
---

`neon plugins` and `neon init` install the Neon plugin again. The plugin always installs user-level through a pinned plugins CLI, so VS Code, GitHub Copilot CLI, Grok Build, and Kimi Code no longer need `--global`. `--global` is removed from `--help`, still accepted, and does the same as the default. `neon plugins -y` falls back to installed apps when it finds no project folder or host agent.
