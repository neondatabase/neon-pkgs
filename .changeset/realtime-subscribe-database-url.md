---
"neon": patch
---

`neon realtime subscribe` authenticates with the branch's `DATABASE_URL`: the Realtime SDK seals the query and that login for the branch's public key, so it works on branches whose Realtime secret is turned off. On a branch whose Realtime server predates envelopes, it falls back to the branch's Realtime secret. Realtime accepts only the `neondb_owner` role for now.
