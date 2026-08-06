---
"neon": minor
---

`neon-init` is deprecated; its whole flow now lives in `neon init`

`neon-init` was a second CLI shipping the setup flow that `neon init` already exposed — `neon`
depended on it, imported five functions from it, and forwarded every command to it. Two
published packages, two release dispatches, and two versions that could drift, for one command.

The code moves into `packages/cli/src/init/` and the package is gone. `neon init` behaves as
before: same phases, same `--data` step routing, same prompts, and it still reaches Neon by
shelling out to `npx -y neon`.

**Run `npx neon init` instead of `npx neon-init`.** No further version of `neon-init` will be
published, so the last one keeps resolving and keeps working — frozen, with its own copy of
every phase handler. There is no alias package: it was a CLI rather than a library, and the
command that replaces it is on a CLI its users already have. The `neon-init/bootstrap` subpath
is gone too; that core is now internal to `neon`, and `neon bootstrap` is its supported surface.

Two things about `neon init --agent` change, because deleting the standalone binary made it the
only agent entry point and it was the weaker of the two:

- **The JSON response goes to stdout, unprefixed.** It was written through the CLI's logger,
  which prefixes every line with `INFO: ` and writes to stderr — a diagnostic channel, for a
  payload agents are told to parse.
- **A failure is JSON as well**, `{"success": false, "error": "…"}` on stdout with exit 1.
  Every error was previously swallowed by a bare `catch {}`: an agent got exit 1, empty stdout,
  and no way to tell a bad `--data` payload from a network failure. Without `--agent` the same
  error is one `ERROR: …` line on stderr.

A damaged credentials file is the one failure that still reports on stderr under `--agent`: the
auth middleware reads credentials before `init`'s skip in `ensureAuth`, so it fails before the
command runs. It names the file and the repair either way.
