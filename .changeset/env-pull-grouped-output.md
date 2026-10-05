---
"neon": patch
---

`neon env pull`, and the env pull bundled into `checkout`, `deploy`, and `config apply`, now print the written variables grouped by service, with new credential values marked `*`, replacing the single long `INFO:` line. A pull that writes object storage or AI Gateway credentials also finishes sooner: the storage read, both credential reveals, and the AI Gateway model check now run concurrently.
