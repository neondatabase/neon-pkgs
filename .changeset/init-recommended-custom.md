---
"neon": major
---

`neon init -y` is Recommended setup: detected agents, link when authenticated, and a default neon.ts. `-y` with `--skill`, MCP flags, `--no-agent-setup`, or `--claimable` is Custom. Init now sets up the current directory in place and no longer accepts template flags. `--mcp-config-location` controls where init writes MCP config, and `--mcp-project-scoped` limits MCP tools to the linked project. Interactive plugins, skills, mcp, init, and bootstrap install after the last picker. When no agents are detected, Recommended writes the default skills in this directory.
