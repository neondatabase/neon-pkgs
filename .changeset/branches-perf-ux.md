---
"neon": patch
---

`neon branches get <name>`, `reset <name> --parent`, `restore <name> ^parent`, and `schema-diff` between two branch names make one fewer API request. In table output, branch names carry colored `[default]`, `[protected]`, and `[current]` labels, displayed branch states are colored, `branches get` shows the parent, creator, and last reset, and colors honor `NO_COLOR`. Scripts that read fields from table output should switch to `-o json`, for example `neon branches get main -o json | jq -r .name`, since a name cell can now read `[default] main`.
