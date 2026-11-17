---
"@neon/realtime": patch
---

Place rows from ordered partial refreshes using the optional protocol v3 `after_row_key` field. Raw subscriptions receive the refresh as removes, upserts and moves, followed by a separate update for each later buffered tick. Replaced rows that keep their row key receive an upsert and move without a remove.
