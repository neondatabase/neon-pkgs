---
"neon": patch
---

A single-value flag given twice with different values (`--parent a --parent b`, `--branch a --branch b`, `-o json --output yaml`) now fails with `--<flag> was given more than once. Pass it at most once.` It used to crash, look up a branch named `a,b`, or fall back to table output. The same value given twice still works.
