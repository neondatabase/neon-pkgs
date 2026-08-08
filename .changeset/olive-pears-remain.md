---
"@neon/sdk": major
---

**Breaking:** `neon.branches.recover` is removed. Neon stopped publishing `POST /projects/{project_id}/branches/{branch_id}/recover` in its OpenAPI spec, so the generated client no longer carries the operation. The endpoint still answers in production, so reach it through the raw client until it returns to the spec and the wrapper with it:

```ts
await neon.client.post({
	url: "/projects/{project_id}/branches/{branch_id}/recover",
	path: { project_id: projectId, branch_id: branchId },
});
```

The same spec refresh adds two namespaces: `neon.projects.members` (`list`, `setRole`, `removeRole`) for the per-project roles of organization members, and `neon.logs` (`query`, `fields`, `fieldValues`) for branch logs.
