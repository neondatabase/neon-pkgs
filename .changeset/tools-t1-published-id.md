---
"@neon/tools": major
---

Published tool ids are now resource-first (`projects.list` → `projects_list`, was `list_projects`). The SDK path lives on `tool.selector` instead of `operationId`. MCP and Mastra hosts pinned to the old names can pass `names`.
