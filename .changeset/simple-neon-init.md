---
"neon": minor
"neonctl": minor
---

`neon init` in an empty directory is `neon bootstrap` (scaffold, agent tooling, link). In an existing app it installs a plugin or skills+MCP, links, then writes neon.ts. `neon bootstrap` offers the same agent tooling after scaffolding; `--default` also runs `link --yes`.
