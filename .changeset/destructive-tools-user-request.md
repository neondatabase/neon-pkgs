---
"@neon/tools": patch
---

Destructive tool descriptions now tell agents to run the tool when the user's own message asks for it, and to ask first otherwise. Before, they said to always ask the user first, so agents stopped to ask before deleting a branch the user had just asked them to delete.
