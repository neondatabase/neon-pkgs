---
"neon": minor
---

`neon config init --from-branch` seeds `neon.ts` from a branch's live Neon state instead of asking which services to declare. It uses the branch pinned in `.neon`, `--branch <name|id>`, or the project's default branch, and declares what the branch actually reports: Neon Auth, the Data API, and object-storage buckets with their access levels, plus the branch's compute settings in the policy closure.

Three things it cannot declare are surfaced rather than guessed: deployed functions are listed as a commented-out block (the branch has no local `source` path), the AI Gateway is mentioned in a header comment (a branch has no readable enabled state for it), and a `protected` branch is reported as a comment instead of a policy field. `--from-branch` conflicts with `--services`, and it is the only mode of `config init` that calls the Neon API.
