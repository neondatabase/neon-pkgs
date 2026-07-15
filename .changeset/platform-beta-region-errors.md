---
"@neon/config": patch
"neon-init": patch
---

Update platform-feature-unavailable errors for the beta rollout: drop outdated
"private preview" / "Preview feature" wording, say features are currently in
beta and only in `aws-us-east-2` (more regions coming shortly), and treat API
bodies that say a feature is unavailable for the project/region as a region gate
(not a transient incident) even when the status is 503. `neon-init`
getting-started prompts use the same wording.
