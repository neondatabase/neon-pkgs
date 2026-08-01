---
"neon": patch
"@neon/config": patch
"@neon/config-runtime": patch
"@neon/env": patch
"neon-init": patch
"neon-new": patch
---

Name the database Lakebase Postgres, and stop calling Neon a platform

Copy only, no behaviour change beyond one error message string.

- `neon`: the npm description no longer says "Neon Serverless Postgres"; the README names the primitives the CLI manages.
- `@neon/config` and `@neon/config-runtime`: "Config-as-Code for the Neon Platform" is now "Config-as-Code for Neon", in the npm descriptions, the README, and the `v1` doc comments.
- `@neon/config`: the validation error `Invalid Neon platform config:` is now `Invalid Neon config:`. Anything matching on that string needs updating.
- `neon-init`: `neon-init auth` is described as "Manage Neon authentication"; the signup prompt no longer calls Neon "a serverless Postgres provider"; two bootstrap template blurbs say Lakebase Postgres.
- `neon-new`: README names Lakebase Postgres.
