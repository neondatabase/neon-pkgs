---
"neon": patch
---

`neon --help` now prints on stdout, so pipes and `grep` see it. Piped help wraps on word boundaries instead of splitting words mid-line.
