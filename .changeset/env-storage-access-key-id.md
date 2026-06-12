---
"@neondatabase/env": patch
---

Fix object storage being unusable from a pulled `.env`. `fetchEnv` (and therefore `neon env pull` / `neon dev`) set `AWS_ACCESS_KEY_ID` to the credential's display-only short id (`token_id_short`) instead of its full `token_id` (e.g. `nak_live_…`). The S3-compatible storage endpoint authenticates with the **full** token id, so every request failed with `InvalidAccessKeyId` ("The AWS Access Key Id you provided does not exist in our records") even though the `.env` looked complete and the bucket existed. Now emits the full `token_id`, so the AWS SDKs work from the pulled env out of the box. `AWS_SECRET_ACCESS_KEY` and the AI Gateway / Postgres vars are unchanged.
