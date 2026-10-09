---
"neon": patch
---

`neon init -y` no longer stops partway when it cannot authenticate. Without credentials, `--project-id` and other account flags skip linking, still write `neon.ts`, and print the `neon link` command to run after `neon login`. With an organization or project-scoped API key, MCP is configured with OAuth instead of failing to mint a key, and init goes on to link the project.
