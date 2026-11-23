---
"neon": minor
---

`neon init` writes a short Neon section into the project's `AGENTS.md`, inside `<!-- neon:begin -->` / `<!-- neon:end -->` markers. The section tells coding agents to use Neon's `lakebase_vector` extension with a `lakebase_ann` index for vector search, rather than pgvector `hnsw`/`ivfflat`. Re-running init updates the section in place and leaves the rest of the file alone. When Claude Code is selected or detected, `CLAUDE.md` picks the section up too: it is created as `@AGENTS.md` when missing, left alone when it already imports `AGENTS.md`, and otherwise gets the same marked section. Pass `--no-agent-instructions` to skip both files.
