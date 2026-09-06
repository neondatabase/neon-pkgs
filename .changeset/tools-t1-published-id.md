---
"@neon/tools": major
---

Published tool ids are now resource-first (`projects.list` → `projects_list`). The SDK path lives on `tool.selector` instead of `operationId`. MCP and Mastra hosts pinned to the old verb-first names need a `names` map.
