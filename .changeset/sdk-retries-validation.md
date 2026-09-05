---
"@neon/sdk": patch
---

`retries` is validated at `createNeonClient`. `NaN`, `Infinity`, fractions, and negatives throw a `"client"`-kind error instead of retrying forever (`NaN`/`Infinity`) or being accepted silently. `0` and the default `2` are unchanged.
