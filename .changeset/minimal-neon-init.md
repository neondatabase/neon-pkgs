---
"neon": major
---

`neon init` is now minimal: it authenticates and installs the Neon tooling (MCP server, agent skills, and — in a VS Code–based IDE — the editor extension), then hands off to the agent. It no longer selects an organization or project, links the directory, pulls environment variables, asks which features to enable, or provisions Auth / Object Storage / Functions / AI Gateway — the installed Neon skill drives all of that from here (or you can run `neon link` yourself).

- Removed flags: `--preview`, `--project-id`, `--org-id`, `--branch-id`, and `--skip-migrations`.
- The agent `--data` step protocol is reduced to `auth`, `setup`, `mcp`, and `skills`. The `getting-started`, `db`, `migrations`, `neon-auth`, `status`, and `finalize` steps are removed.
- Interactive `neon init` no longer scaffolds from a template or configures Neon Auth; it installs tooling and points you at your agent (or `neon link`).

The standalone `neon bootstrap` command is unaffected.
