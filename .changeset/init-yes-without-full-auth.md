---
"neon": patch
---

`neon init -y` no longer stops partway when it cannot authenticate. Without credentials, `--org-id`, `--project-id`, and `--branch` write `.neon` offline alongside `neon.ts`, and init prints `neon login` as the next step; with fewer account flags it prints the `neon link` command to run after signing in. With an organization or project-scoped API key, MCP is configured with OAuth instead of failing to mint a key, and init goes on to link the project. With `--mcp-auth api-key`, init finishes linking and `neon.ts` first, then reports the MCP failure with the `neon mcp` commands to retry.
