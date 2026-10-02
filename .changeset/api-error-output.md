---
"neon": patch
---

A failed API request with no error message now prints `ERROR: HTTP <status> <text> | <path>` instead of exiting silently. `neon api -i` prints the failed response's status, headers, and body. In a terminal, `neon api` colors its JSON, `-i` status line, and `--list` methods; piped output stays plain.
