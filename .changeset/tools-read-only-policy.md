---
"@neon/tools": minor
---

Every tool now reports `metadata.readOnlySafe`, and `readOnly: true` on `createNeonTools`, `createNeonTool`, or `execute` refuses the tools that are not read-only safe before they send a request. `tools` also accepts a predicate over tool metadata, such as `(tool) => tool.metadata.readOnlySafe`.
