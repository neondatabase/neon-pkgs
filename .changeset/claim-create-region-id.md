---
"neon": minor
---

`neon claim create --region-id <region>` and `neon init --claimable --region-id <region>` create the claimable project in that region. Without the flag, the project is still created in `aws-us-east-2`. `claim create` output now includes `region_id`.
