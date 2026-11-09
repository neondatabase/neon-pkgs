---
"neon": minor
"neonctl": minor
---

Allow Function Registry catalog entries to load template files from a public GitHub repo via `source.github` (`owner`, `repo`, optional `ref` — a branch such as `release/v1`, a tag, or a commit, defaulting to `HEAD` so it follows the repo's default branch — and optional `dir`). The index can stay in `neondatabase/examples` while a partner owns the template tree. A catalog entry whose `source` this CLI version does not understand still lists, and asks you to update the CLI when picked.

`neon functions new` now reads Neon's own templates from one `neondatabase/examples` archive, so every file of a template comes from the same commit even right after a push, and falls back to reading files one by one when the archive cannot be downloaded. Template files are fetched a few at a time in parallel, and a redirected or timed-out read now says so instead of reporting a connection problem.

`GITHUB_TOKEN` / `GH_TOKEN` is now sent only to GitHub's own hosts: `neon bootstrap` and `neon skills status` no longer send it to neon.com or an override URL, and `source.github` reads never send it.
