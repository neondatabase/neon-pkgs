---
"neon-init": minor
---

Redesign the interactive template picker. Rows now show the template title only, and the focused row expands to `Title (tools)` with the description on its own dimmed, italic line beneath — driven by a custom `@clack/core` select so the focused option can span multiple lines. Bootstrap templates gain an optional `tools` list (the libraries/frameworks that shape the project), parsed from the manifest and surfaced in both the interactive and agent-guided flows.
