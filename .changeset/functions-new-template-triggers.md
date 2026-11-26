---
"neon": minor
---

`neon functions new` declares a template's Function Triggers in `neon.ts`. A Function Registry template can list `triggers` (`schedule` with a cron expression, or `storage_object_created` with a bucket and optional prefix), and each one is written to `triggers` after the scaffolded function, pointed at that function and, for a `router` operation, at the operation's route. A trigger name `neon.ts` already declares is left as it is, and the declaration to add by hand is printed instead. The bucket a storage trigger watches is never declared for you: when `neon.ts` lacks it, the next steps say to run `neon config add bucket <name>`. With `--no-add-to-config`, a `neon triggers create` command is printed for each trigger. `-o json` reports them under `triggers`.
