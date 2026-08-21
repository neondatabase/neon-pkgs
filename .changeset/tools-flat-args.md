---
"@neon/tools": minor
---

Generated tools take flat arguments instead of an OpenAPI path/query/body envelope. `create_project` takes `{ name, region_id, org_id, ... }`. `name` and `names` rename the published tool id.
