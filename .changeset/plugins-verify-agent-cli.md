---
"neon": patch
---

`neon plugins` and `neon init` check that GitHub Copilot CLI and Grok Build actually run before installing the Neon plugin through them. A `copilot` that is not the real CLI (such as VS Code's launcher without Copilot CLI installed), a Copilot CLI older than 0.0.400, or a `grok` whose `--version` fails is now skipped with a warning naming the reason, and `neon init` installs Neon skills and MCP for that agent instead. Before, the install failed.
