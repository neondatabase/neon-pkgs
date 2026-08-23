---
"neon": major
"neonctl": major
---

`neon neon-auth config email-provider test` now sends through the custom SMTP provider saved on the branch. Only `--recipient-email` is required; `--host`, `--port`, `--username`, `--password`, `--sender-email`, and `--sender-name` are rejected. Save the provider first with `neon neon-auth config email-provider update`.
