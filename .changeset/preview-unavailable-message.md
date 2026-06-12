---
"@neondatabase/config": patch
---

Make the "Preview feature unavailable" error status-aware and actionable instead of a misleading catch-all. When a `neon.ts` declares a Preview feature (Functions, object-storage buckets, branch credentials) that the project/region hasn't been granted, the reads behind `plan` / `apply` / `status` / `env pull` surfaced `"… is a Preview feature that is not available for this project or region … Enable it for your Neon account/project first"` — which read like the user had misconfigured something they could simply "enable".

`previewUnavailableError` now:

- Names the failing feature and summarizes the response in one short `HTTP <status> <reason>` line (e.g. `HTTP 404 Not Found`) — never a stack trace — and keeps the raw Neon API message + request id inline, which is valuable signal while these features are in preview.
- Tailors the guidance to the HTTP status: a 404/501 points at region availability / private-preview access ("create a project in a region where the preview is enabled, and make sure your account has access"); a 503 distinguishes "still rolling out" from a transient incident and points at https://neonstatus.com / Neon support; everything else falls back to a generic account/region message.
- Offers removing the feature from the `preview` block of your `neon.ts` as an escape hatch, and carries `status` / `requestId` on `error.details` for programmatic consumers.
