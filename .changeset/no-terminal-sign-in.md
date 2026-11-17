---
"neon": patch
---

Without a terminal on stdin, as in a coding agent's shell or a script, a command that finds no usable credential now exits with an error naming `neon login` and the API key options instead of waiting 60 seconds for a browser sign-in. `neon login` still starts the browser sign-in there.
