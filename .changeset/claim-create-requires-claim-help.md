---
"neon": patch
---

`neon claim create --help` now says what a claimable project gets before it's claimed. Auth and the Data API are provisioned when requested. Functions, Object Storage, and the AI Gateway are only recorded and reported in `denied_capabilities`, and nothing is provisioned for them (`neon dev` still runs functions locally). An app that needs them should have a human sign in first and create a regular project instead.
