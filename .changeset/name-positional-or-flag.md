---
"neon": patch
---

`neon databases create`, `databases delete`, `roles create` and `roles delete` now take the name either as the first argument or as `--name`. Before, `create` took only `--name` and `delete` took only the argument, so `neon databases create analytics` failed with `Missing required argument: name` and `neon databases delete --name analytics` failed with `Not enough non-option arguments: got 0, need at least 1`. Every form that worked still works. Giving two different names fails before any request. A `delete` with no name now reports `Missing required argument: name`. The same applies to `neon postgres databases` and `neon postgres roles`.
