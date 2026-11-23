---
"neon": minor
---

`neon init` writes a short Neon section into the project's `AGENTS.md`, inside `<!-- neon:begin -->` / `<!-- neon:end -->` lines. The section tells coding agents to use Neon's `lakebase_vector` extension with a `lakebase_ann` index for vector search, rather than pgvector `hnsw`/`ivfflat`, unless pgvector or portability is asked for. Re-running init updates the section in place and leaves the rest of the file alone. Writes are atomic and skip a file that changed while init ran. When this project uses Claude Code (picked or named in init, init run from Claude Code, or an existing `.claude/` or `CLAUDE.md`), `CLAUDE.md` picks the section up too: it is created as `@AGENTS.md` when missing, left alone when it already imports `AGENTS.md`, and otherwise gets the same marked section. Pass `--no-agent-instructions`, or `--no-agent-setup`, to skip both files.
