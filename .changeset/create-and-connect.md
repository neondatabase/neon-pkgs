---
"@neon/sdk": major
"@neon/tools": major
---

`branches.create` attaches a read-write endpoint by default; pass `noCompute: true` (tools: `no_compute`) to skip it. `createWithCompute` is now `createAndConnect`. `create` returns the resource without a connection string; `createAndConnect` returns a URI.
