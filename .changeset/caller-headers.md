---
"neon": patch
---

`neon docs search` and `neon ask` send their caller headers as `x-caller-*`. The Neon Functions proxy dropped the earlier `x-neon-*` names, so the service never saw the CLI as the caller, and `neon docs search --no-analytics` did not stop the search from being recorded.
