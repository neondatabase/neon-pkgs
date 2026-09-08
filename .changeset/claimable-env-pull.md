---
"neon": patch
---

`neon env pull` works on unclaimed Claimable Neon projects. A `neon.ts` that only declares Postgres, Auth, and the Data API is honored; one that names AI Gateway, Functions, or Object Storage fails until the project is claimed. `neon claim create` writes the same vars as that pull.
