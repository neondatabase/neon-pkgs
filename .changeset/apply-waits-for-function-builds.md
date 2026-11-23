---
"@neon/config-runtime": patch
"@neon/config": patch
"neon": patch
---

`neon deploy`, `neon checkout`, `neon config apply`, and `apply()` now wait for every function deployment they submit to finish building before reporting success, and fail with the platform's reason when a build fails. Previously they returned while the build was still running, so the printed function URL answered 404 until it finished.
