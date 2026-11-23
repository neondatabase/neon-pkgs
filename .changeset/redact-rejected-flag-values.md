---
"neon": patch
---

Errors for an invalid `--services`, `--category`, `--skill`, `--agent`, `--template`, `--operation`, `neon-auth plugins get` name, `api -X` / `-H` / `-f`, `functions deploy --env`, `snapshots schedule` frequency, or any flag with a fixed list of choices (such as `--output`) now print `<redacted invalid value>` in place of the value you typed, as `env pull --env` already did, so a secret pasted into the wrong flag is not sent with error telemetry. Errors that listed the valid values still do, and a value within two characters of a valid one gets a "Did you mean" suggestion.
