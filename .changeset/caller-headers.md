---
"neon": patch
---

`neon docs search` and `neon ask` send their caller headers as `x-caller-*`. The Neon Functions proxy dropped the earlier `x-neon-*` names, so the service never saw the CLI as the caller, and `--no-analytics` did not stop a search from being recorded. `neon ask --no-analytics` now also asks the service to record nothing, including the prompt and answer.
