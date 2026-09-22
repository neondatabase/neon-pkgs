# Neon CLI (`packages/cli`)

## CLI for agents

- `--help` lists every value an enum flag accepts.
- `-y` / `--yes` / `--default` is the non-interactive path. If it cannot decide, the error names the flag (and values) to pass.
- Every command exposes flags for every interactive question so it can run with no TTY.

Coding-agent targeting is `--agent <name>` (repeatable) on `skills`, `plugins`, `mcp`, `init`, and `bootstrap`; detection on `-y` (global config, project folders, and the host CLI); or omit `-y` in a terminal to pick. `init` Recommended may install the plugin and skills/MCP in one run when detected agents need both; `bootstrap` still refuses that mix. Interactive Custom init finishes agent setup before project setup, then calls link or `claim create` in process. `--no-link` skips linking without prompting. `link` has no `--agent`. `neon init -y` is Recommended: it does not scaffold a template (use `--template` or `neon bootstrap`), links only when authenticated, and writes a default `neon.ts` unless `--no-config`. `-y` with `--skill`, MCP flags, `--no-agent-setup`, or `--claimable` is Custom. `--skill` selects skills; MCP flags select skills and MCP. neon.ts flags on `init` are `--config` / `--no-config` / `--services`. Scaffolding keeps the template's neon.ts. Init suppresses link's own neon.ts offer.

Human output (`-o table`, the default) is for a terminal. `-o json` and `-o yaml` are for scripts. Never parse the human format in a script, a test that is checking a machine contract, or an agent workflow that needs a field.

## Parent commands

A command that only groups subcommands prints its own help and exits 0 when run
without a subcommand. Do not add a top-level `demandCommand` to these command
modules; the help middleware in `src/index.ts` handles the bare invocation.
Commands that perform an action of their own belong in `NO_SUBCOMMANDS_VERBS`
and keep that action.

## `-o table`

Implemented in `src/writer.ts` and `src/human_table.ts`. Every list and get goes through `writer`. Do not draw a table in a command.

- No box-drawing characters (`┌─┬┐│└┘`).
- A list (array) is space-padded columns with a two-space gutter and a Title Case header. Every present field is printed at full width on one line per row. A TTY that is too narrow wraps that line; widening it unwraps it. Do not drop, shrink, or stack list columns to fit.
- A single object is stacked `Label  value` lines, one field per line.
- A one-column list stays one column. Do not truncate those values, or stacked `Label  value` values (connection URIs and `--extended` host/password have to stay copyable).
- Unknown width (a pipe, a test stream, no `columns`) is the same list layout. Width is used only to shrink stacked labels.
- Width, in order: the `columns` argument on `writer` (tests), then `out.columns` when that stream has one, then `COLUMNS` and only when `out` is `process.stdout`. Never read `process.stdout.columns` for a different stream.
- Flatten every cell to one line before layout, including `renderColumns` output. Arrays join with `, `; objects are compact JSON.
- Title and `emptyMessage` are not rows. The API-key secret is `writer.text`, not a cell — it stays one selectable line, even if that line is longer than the TTY.

`src/psql/print` emulates psql. `src/help.ts` is the yargs help renderer. Leave both alone.
