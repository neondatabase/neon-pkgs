---
"neon": minor
---

Add `neon mcp serve`, a stdio MCP server that relays to the Neon MCP server with the CLI's credential (`--api-key`, `NEON_API_KEY`, or `--profile`). Configure an agent with `{ "command": "neon", "args": ["mcp", "serve"] }`. An OAuth profile mints one API key on first use and keeps it with the session.
