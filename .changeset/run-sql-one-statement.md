---
"@neon/tools": patch
---

The `sql.run` description now says to send several statements one per call or through `sql.runTransaction`, since a `sql.run` call with more than one statement fails.
