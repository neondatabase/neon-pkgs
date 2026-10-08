---
"neon": minor
---

`neon deploy` and `neon config apply` ask before applying to a protected branch or overriding settings the branch already has, and show the settings they would override. Without a terminal, or with `-o json|yaml`, they exit 1 before changing anything and name the flag to pass: `--allow-protected`, `--update-existing`, or `-y` for both. Applying to a protected branch now needs that confirmation; before, `--allow-protected` had no effect and the apply went ahead. `-y` / `--yes` now covers both confirmations instead of only `--update-existing`.
