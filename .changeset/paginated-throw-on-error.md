---
"@neon/sdk": minor
---

`Paginated.page()` and `Paginated.all()` now honour `throwOnError` (client-wide and per call), matching every other method. With `throwOnError: true` they resolve to the bare page / item array and reject on failure instead of always returning `{ data, error }`. `Paginated<T>` gained a second type parameter `Throw` (default `false`), and `Consumption` is now generic over the client's `throwOnError` like the other resources. Default (`throwOnError: false`) clients are unaffected; the async iterator still throws on a page error.
