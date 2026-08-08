---
"neon": minor
---

`neon env pull` now pulls the AI Gateway variables (`NEON_AI_GATEWAY_TOKEN`, `NEON_AI_GATEWAY_BASE_URL`) when the working directory has no `neon.ts`, so a bare pull writes everything the branch can give you. A `neon.ts` still decides on its own, and the pull bundled into `link` / `checkout` / `config apply` is unchanged.

New `--service` (`-s`) flag scopes a pull to `postgres`, `auth`, `data-api`, `object-storage`, and/or `ai-gateway`, overriding `neon.ts`. A scoped pull writes and prunes only within the services you name, so `neon env pull -s ai-gateway` leaves your `DATABASE_URL` alone.
