---
"neon": patch
"neonctl": patch
---

`neon dev` no longer replaces the global `Request` and `Response` classes, so a function sees the same ones it gets when deployed. Frameworks that check `instanceof Response` against a Response they built themselves now behave the same locally as deployed: with h3 v2, every error response (a thrown 400, 404 or 500, or an unknown route) used to come back from `neon dev` as `200 [object Response]`.
