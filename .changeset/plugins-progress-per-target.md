---
"neon": patch
---

`neon plugins` (and the plugin install step of `neon init`) now prints a progress line for each coding agent before installing into it, e.g. `Installing the Neon plugin for Cursor (1/2)...`, instead of staying silent between agents.

`neon init` and `neon bootstrap` no longer re-execute the `neon` binary as a child process to install the plugin, skills, and MCP config, or to pull env vars — they call the same code `neon plugins` / `neon skills` / `neon mcp` / `neon env pull` call, in-process. Faster (no extra CLI boot per step). A failed step now surfaces its real, detailed error directly instead of that plus a separate generic `` `neon plugins ...` failed. `` wrapper — no information lost, just no duplicate line. Retry commands are unchanged.
