---
"neon": patch
---

`neon init -y` and `neon plugins -y --global` no longer fail on GitHub Copilot CLI or Grok Build when `copilot` or `grok` is not on PATH. `neon plugins` skips them with a warning, and `neon init` installs Neon skills and MCP for them instead.
