---
"neon": minor
---

Failures in `neon skills` and `neon mcp` now report which step failed and why. The `CLI Error` analytics event gains `command`, `step`, `errorKind`, `errorKinds` (one reason per failure when a skills error stands for several), `agents`, `skills`, `scope`, and the child process's `exitCode`, `timedOut` and `signal`. For these errors the message is cut to the last 500 characters and the stack to 2,000, with home and working directories and credentials removed from both. Nothing changes in what the commands print, and nothing is sent with `--no-analytics`.
