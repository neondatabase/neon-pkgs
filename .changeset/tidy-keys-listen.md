---
"neon": patch
---

Stop deleting stored credentials when a 401 comes from an API key. A rejected `--api-key` or `NEON_API_KEY` no longer signs you out of the account saved in your config directory, and reports the rejection instead of retrying. When the stored OAuth token is what was rejected, it is still cleared — but now from the directory named by `--config-dir` rather than always the default one.
