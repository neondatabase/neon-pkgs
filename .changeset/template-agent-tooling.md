---
"neon": minor
---

`neon bootstrap` and `neon functions new` now install the skills, MCP servers, and CLIs a template suggests for coding agents. A template declares them in an `agent` block. Skills are installed with the skills CLI, MCP servers with the add-mcp CLI (both run with npx, project scope), npm CLIs are installed globally with `npm install -g` when they are not already on PATH, and system CLIs are checked with `--version` and printed install hints. A terminal asks separately which skills (each listed on its own), MCP servers, and CLIs to install. `-y` installs the recommended skills and MCP servers only for Neon's own templates and prints npm CLI global installs instead of running them, `--template-tooling` installs them for any template without asking, and `--no-template-tooling` skips them. `neon functions new` adds `--agent`. Third-party templates fill `${NAME}` values only from a prompt, and a config tracked by git is never given a secret.
