---
"@neon/sdk": major
---

**Breaking:** `neon.branches.recover` is removed. Neon stopped publishing `POST /projects/{project_id}/branches/{branch_id}/recover` in its OpenAPI spec, so the generated client no longer carries the operation. The endpoint still answers in production, so reach it through the low-level client until it returns to the spec and the wrapper with it:

```ts
import type { BranchRecoverResponse } from "@neon/sdk";

const { data } = await neon.client.post<{ 200: BranchRecoverResponse }>({
	url: "/projects/{project_id}/branches/{branch_id}/recover",
	path: { project_id: projectId, branch_id: branchId },
});
const branch = data?.branch;
```

That envelope carries the API's own error body rather than a `NeonError`, and the `{ 200: … }` wrapper is required — passing `BranchRecoverResponse` directly resolves to a union of its members. `neon.projects.recover` is a different endpoint and is unaffected.

The same spec refresh adds two namespaces: `neon.projects.members` (`list`, `setRole`, `removeRole`) for the per-project roles of organization members, and `neon.logs` (`query`, `fields`, `fieldValues`) for branch logs.
