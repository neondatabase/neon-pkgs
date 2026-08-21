---
"@neon/tools": minor
---

`createNeonTools` accepts a `workflows` array that exposes `@neon/sdk` methods as `createBranchWithCompute` and `createProjectAndConnect`. Those tools attach compute, wait for readiness, and return a connection string. `CreateNeonToolsOptions` is a type alias, so an `interface` cannot extend it; `createNeonTools`'s first type argument is the options object.
