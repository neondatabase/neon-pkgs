---
"@neon/config": minor
---

`ComputeUnit` now covers every compute size Neon offers (0.25, 0.5, 1–16, and even sizes 18–56 for fixed-size computes), and `computeSettingsSchema` validates the documented autoscaling rules (bounds up to 16 CU, range at most 8 CU).
