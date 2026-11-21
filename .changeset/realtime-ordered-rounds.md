---
"@neon/realtime": patch
---

Place rows from ordered partial refreshes using the protocol v3 selected-scope `ordered: true` flag and optional row `after_row_key` field, including refreshes that return no rows. Raw subscriptions receive the refresh as removes, upserts and moves, followed by a separate update for each later buffered tick. Replaced rows that keep their row key receive an upsert and move without a remove.

Use `segment_tag` selectors and string-or-absent round row anchors from the finalized v3 schema. Keep selected rounds ordered or unordered consistently for each live ID, including across epoch resets.
