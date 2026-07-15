---
"@neon/config": patch
"neon-init": patch
---

Update platform-feature-unavailable errors for the public beta: drop outdated
"private preview" / "Preview feature" wording, name `aws-us-east-2` explicitly,
and treat API bodies that say a feature is unavailable for the project/region as
a region gate (not a transient incident) even when the status is 503. `neon-init`
getting-started prompts now describe the public-beta region requirement the same
way.
