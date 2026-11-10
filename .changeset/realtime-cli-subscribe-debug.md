---
"neon": patch
---

Add `--debug` to `neon realtime subscribe`. It requests full database error details from Realtime and shows the SQLSTATE beside the message, so a rejected or failing live query names its cause. Details can include schema object names and row values; use the flag with your own database.
