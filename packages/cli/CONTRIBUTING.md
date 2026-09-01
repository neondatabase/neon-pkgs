# Contributing to the Neon CLI

Setup, Node floors, and how to run tests live in the
[repo-root `CONTRIBUTING.md`](../../CONTRIBUTING.md). CLI-for-agents rules (`--help`
lists enums; `-y` errors name the flag to pass; every command can run with no TTY)
live in [`AGENTS.md`](./AGENTS.md). This file is the human-output contract for
`-o table`.

## Human output is not a machine API

`--output json` and `--output yaml` are what scripts and tests that need a field
should read. The default (`table`) is for a person looking at a terminal. If a
row is wider than the terminal, a box-drawing table wraps mid-cell and the
alignment is gone. Do not add `cli-table` or any other box drawer.

All list and get commands go through `writer` in `src/writer.ts`. Change the
layout there, not in a command.

## Layout

| Input | Format |
| --- | --- |
| An array (a list) | Space-padded columns, two-space gutter, Title Case header. Every present field, full width, one line per row. |
| A single object | Stacked `Label  value`. The value is not truncated. |
| A one-column list | The header, then one value per line. Values are not truncated. |

A list does not drop, shrink, or stack columns to fit the TTY. If a row is
wider than the terminal, the terminal wraps that line; widening the terminal
unwraps it. Width (`stdout.columns`, or `COLUMNS` when writing to stdout) is
used only to shrink stacked labels. Do not guess `process.stdout.columns` for a
different stream.

Cells are one line. Newlines become spaces. Arrays join with `, `. Objects are
compact JSON. `renderColumns` goes through the same flattening.

```
Projects
Id                       Name                        Region Id      Created At
wandering-haze-25754674  claimable-neon-local-state  aws-us-east-2  2026-08-11T16:42:59Z
```

```
Id      wandering-haze-25754674
Name    claimable-neon-local-state
Region  aws-us-east-2
```

The API-key secret stays on its own line under the metadata so it can be
selected in one gesture. That line is allowed to be longer than the TTY.
`emptyMessage` is a message, not a row.

## Out of scope

`src/psql/print` is a psql clone and keeps psql's own table modes.
`src/help.ts` is yargs help. Neither is `-o table`.
