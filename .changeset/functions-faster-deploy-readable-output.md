---
"neon": patch
---

`neon functions deploy` checks the new deployment after 200 ms instead of 2 s, backing off to 2 s for longer builds, so a small deploy finishes about 2 s sooner. Its table output is one block headed by the function, with the URL first and the deployment ID labeled; `functions get` and `functions list` use the same labels. JSON and YAML output is unchanged.
