---
"@neon/env": minor
"neon": patch
"neonctl": patch
---

`neon env pull` now verifies branch credential secrets instead of trusting whatever is on disk.

Object storage and AI Gateway secrets are returned once at mint time, so `fetchEnv` reuses the persisted copy rather than minting a credential per call. That reuse was presence-based: any non-empty value was kept. Copying a `.env.example` whose secrets are placeholders and running `neonctl env pull` therefore left the placeholders in place, reported as pulled, and the resulting `.env` did not work.

`fetchEnv` gains a `credentials` option. The default, `"reuse"`, is the existing behavior and is what `neon dev` / `neon-env run` keep — they inject what a pull already wrote and shouldn't pay an API call per start. `env pull` now passes `"verify"`, which checks the persisted secrets against the branch's live credentials and keeps them only if they name one that still exists, isn't revoked or expired, and carries every scope the policy needs. Anything else is replaced with a freshly minted credential, and the credential it replaced is revoked so a branch doesn't accumulate one per pull. No local bookkeeping is needed: `AWS_ACCESS_KEY_ID` is the credential's token id and the AI Gateway token embeds its short id, so the persisted secrets already name the credential that issued them.

A new `onCredential` option reports what happened (`action`, the affected `keys`, and any `revoked` token ids); `env pull` uses it to name the values that changed. Also: `fetchEnv` now reads a branch's storage settings before resolving the credential, so a policy declaring buckets on a branch without storage fails without having minted anything.
