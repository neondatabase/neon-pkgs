# Neon CLI (`packages/cli`)

Human output (`-o table`, the default) is for a terminal. `-o json` and `-o yaml` are for scripts. Never parse the human format in a script, a test that is checking a machine contract, or an agent workflow that needs a field.

## `-o table`

Implemented in `src/writer.ts` and `src/human_table.ts`. Every list and get goes through `writer`. Do not draw a table in a command.

- No box-drawing characters (`┌─┬┐│└┘`).
- A list (array) is space-padded columns with a two-space gutter and a Title Case header.
- A single object is stacked `Label  value` lines, one field per line.
- A one-column list stays one column. Truncate values when a width is known.
- When a TTY width is known, a list row must not exceed it. Drop trailing fields first (callers already put the identifying fields first), then truncate cells with `...`. If two columns still do not fit, stack that chunk and show every field.
- Unknown width (a pipe, a test stream, no `columns`): full values, no truncate, no drop.
- Width, in order: the `columns` argument on `writer` (tests), then `out.columns` when that stream has one, then `COLUMNS` and only when `out` is `process.stdout`. Never read `process.stdout.columns` for a different stream.
- Flatten every cell to one line before layout, including `renderColumns` output. Arrays join with `, `; objects are compact JSON.
- Title and `emptyMessage` are not rows. The API-key secret is `writer.text`, not a cell — it stays one selectable line, even if that line is longer than the TTY.

`src/psql/print` emulates psql. `src/help.ts` is the yargs help renderer. Leave both alone.
