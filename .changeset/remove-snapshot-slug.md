---
"@neon/sdk": major
"@neon/tools": major
"neon": major
---

Remove snapshot slugs. The Management API no longer accepts or returns `slug`, so `snapshots.create({ slug })` and `Snapshot.slug` (SDK, tools) and `neon snapshots create --slug` (CLI) are gone; snapshots resolve by id or unique name.
