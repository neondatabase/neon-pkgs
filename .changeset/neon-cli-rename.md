---
"neon-init": patch
"@neon/env": patch
"@neon/config": patch
"@neon/sdk": patch
---

Reference the `neon` CLI over `neonctl` in user-facing output and docs. The CLI
ships both the `neon` and `neonctl` binaries; `neonctl` keeps working as an
alias, but `neon init` now emits `neon …` commands, status messages, and
agent-facing prompts using the cleaner `neon` name, and the package READMEs
document `neon`. Internal package install/version checks and the
`~/.config/neonctl/` config path are unchanged.
