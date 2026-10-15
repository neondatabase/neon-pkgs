---
"neon": minor
---

Analytics now gives each installation a random anonymous id, stored as `anonymous_id` in the config directory. Commands run before sign-in are reported under that id instead of one shared "anonymous" user, and once a command knows the user it sends both ids so the earlier events can be linked to the account. The id isn't created in CI or with `--no-analytics`.
