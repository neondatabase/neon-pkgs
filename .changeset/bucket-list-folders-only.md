---
"neon": patch
"neonctl": patch
---

`neon bucket object list` no longer prints "No objects found." after a list of folders, which read as an empty bucket. When the folder view has folders but no objects directly under the prefix, it now says so and suggests listing a folder or passing `--recursive`. A listing with nothing in it still prints "No objects found.", and `--output json` and `--output yaml` are unchanged.
