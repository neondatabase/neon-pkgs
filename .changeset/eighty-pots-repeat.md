---
"neon": minor
"@neon/env": minor
---

`neon env pull` now pulls the AI Gateway variables (`NEON_AI_GATEWAY_TOKEN`, `NEON_AI_GATEWAY_BASE_URL`) when the working directory has no `neon.ts`, so a bare pull writes everything the branch can give you. A `neon.ts` still decides on its own, and the pull bundled into `link` / `checkout` / `config apply` is unchanged.

New `--service` flag scopes a pull to `postgres`, `auth`, `data-api`, `object-storage`, and/or `ai-gateway`, overriding `neon.ts`. A scoped pull writes and prunes only within the services you name, so `neon env pull -s ai-gateway` leaves your `DATABASE_URL` alone.

Every services flag in the CLI now shares one vocabulary and one syntax: `-s`, `--service` and `--services` are interchangeable, values can be repeated or comma-separated, and a service is spelled the same way on every command. That renames `neon config init --services storage` to `object-storage`; the old spelling still works and warns.

`fetchEnvReusingSecrets` (`@neon/env/runtime`) takes a new `revokeSuperseded` option. It defaults to `true`, the existing behaviour. Pass `false` when the call resolves only part of what a branch has: object storage and the AI Gateway share one credential, so revoking the one your persisted secrets name can break a service the call is not rewriting. The credential it then leaves live is reported as `credential.superseded`, the counterpart to the existing `credential.revoked`.
