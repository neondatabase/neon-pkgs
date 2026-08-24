---
"neon": minor
---

Add `neon inspect db stalled-queries`, a read-only snapshot of active queries running longer than 30 seconds. Table output shows duration, wait event, blocking pids, role, query group, and query. `--output json` includes the full row.
