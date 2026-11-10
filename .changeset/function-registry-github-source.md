---
"neon": minor
"neonctl": minor
---

`neon functions new` and `neon functions templates list` now also read the new `neondatabase/registry` repo, listed ahead of `neondatabase/examples`, with templates present in both shown once. Until `neondatabase/registry` has an index, the CLI keeps using `neondatabase/examples` alone; if it has one that fails to load, the CLI warns and lists the examples templates.

A `neondatabase/registry` entry can load its template files from a public GitHub repo via `source.github` (`owner`, `repo`, optional `ref` — a branch such as `release/v1`, a tag, or a commit, defaulting to `HEAD` so it follows the repo's default branch — and optional `dir`), so a partner owns the template tree while Neon keeps the index. Entries in `neondatabase/examples` cannot set `source`, so CLIs that predate it never list a template they cannot load. An entry whose `source` this CLI version does not understand still lists, and asks you to update the CLI when picked.

`neondatabase/registry` templates are read from one archive of the repo, so every file of a template comes from the same commit even right after a push, and fall back to reading files one by one when the archive cannot be downloaded (`DEBUG=1` shows why). `neondatabase/examples` templates are read file by file. Template files are fetched a few at a time in parallel, and a redirected or timed-out read now says so instead of reporting a connection problem.

`GITHUB_TOKEN` / `GH_TOKEN` is now sent only to GitHub's own hosts: `neon bootstrap` and `neon skills status` no longer send it to neon.com or an override URL, and `source.github` reads never send it.
