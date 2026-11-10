---
"neon": patch
---

`neon realtime subscribe` authenticates with the branch's `DATABASE_URL` instead of the Realtime secret. It reads only `DATABASE_URL` and `NEON_REALTIME_URL`, and the Realtime SDK seals the query and that login for the branch's public key, so it works on branches whose Realtime secret is turned off. Realtime accepts only the `neondb_owner` role for now.
