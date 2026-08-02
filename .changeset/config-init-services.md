---
"neon": minor
---

`neon config init` now asks which Neon services the scaffolded `neon.ts` should declare — Managed Better Auth, AI Gateway, Functions, Object Storage — and writes them into the policy. Selecting Functions also scaffolds the `hello.ts` handler the declared function points at.

`--services auth,ai-gateway,functions,storage` picks them without a prompt, `--services none` scaffolds the bare starter policy, and a run with no TTY (CI, an agent) keeps writing exactly the file it wrote before.
