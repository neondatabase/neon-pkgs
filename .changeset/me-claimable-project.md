---
"neon": patch
---

`neon me` in a directory linked by `neon claim create` now prints the Claimable project it authenticates as (`-o json`: `{"auth_method": "claimable", "project_id": …, "project_expires_at": …}`). It used to exit 1 with `No route exists at this path.`
