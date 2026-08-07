---
"neon": patch
---

Attribute unauthenticated CLI runs to `anonymous` instead of an empty identity.

`ensureAuth` deliberately returns early for `auth`, `bootstrap`, `dev`, `init`, `profile`
and `config init`, so those commands reach telemetry with no credentials and the internal
`userId` is still `""`. The post-auth `identify` fell back with `?? "anonymous"`, and `""`
is not nullish, so it sent `userId: ""` — an identify carrying no identity. It now falls
back with `||`, matching every `track()` call in the same file.

The same empty value reached the `cli_command_success` event, which reported
`accountId: ""` alongside `authMethod: "oauth"` on runs where nothing had authenticated
at all. Both fields are now left unset unless a user id was actually resolved.

No user-visible behavior changes; this only affects what the CLI reports about itself.
