---
"neon": patch
---

Browser sign-in (`neon login`, and the sign-in other commands start when no credential is found) now waits up to 10 minutes for the browser to finish, up from 60 seconds, and says so in the waiting message and in `neon login --help`.
