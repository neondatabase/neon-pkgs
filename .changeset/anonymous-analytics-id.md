---
"neon": minor
---

Analytics now gives each installation a random anonymous id, stored as `anonymous_id` in the config directory, and sends it as `anonymousId` with every event. Signed-out commands keep the shared "anonymous" user id, so existing queries on it still work, and once a command knows the user it sends the real user id with the same anonymous id so the earlier events can be linked to the account. The id isn't created in CI or with `--no-analytics`.
