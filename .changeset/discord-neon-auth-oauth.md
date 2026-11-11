---
"neon": minor
---

Add `discord` to `neon neon-auth oauth-provider`. Discord requires custom OAuth application credentials; the CLI accepts its client ID and client secret, rejects shared credentials with a hint naming those flags, and prints its callback URL.
