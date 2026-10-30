---
"neon": minor
"neonctl": minor
---

`neon init --services data-api` and `neon config init --services data-api` now read the linked branch's Data API before writing `neon.ts`. When it verifies an external identity provider (Clerk, Auth0, …), or the API does not report a provider and Neon Auth is off on the branch, the scaffold declares `dataApi: { authProvider: "external", … }` with the wiring the API reports and no longer writes `auth: true` — so the first `neon deploy` stops enabling Neon Auth over a Data API that never used it. A branch whose Data API uses Neon Auth, or no linked project, gets the same file as before. The read uses credentials already on hand and never starts a login; without any, the scaffold keeps the Neon Auth default and prints a warning.
