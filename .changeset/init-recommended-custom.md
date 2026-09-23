---
"neon": major
---

`neon init -y` is Recommended setup: detected agents, link when authenticated, and a default neon.ts. `-y` with `--skill`, MCP flags, `--no-agent-setup`, or `--claimable` is Custom. Empty directories are no longer scaffolded; use `--template` or `neon bootstrap`. `--template` continues into the rest of init. `--mcp-config-location` and `--mcp-project-scoped` are the same flags on `neon init` and `neon mcp`. Interactive plugins, skills, mcp, init, and bootstrap install after the last picker. When no agents are detected, Recommended writes the default skills in this directory.
