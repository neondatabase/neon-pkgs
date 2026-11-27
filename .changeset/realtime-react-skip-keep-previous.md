---
"@neon/realtime-react": patch
---

Skip a live query and keep the previous rows while the next one loads. `useLiveQuery(null)` opens no subscription and returns a stable idle result (`status: "closed"`, no `data`), so components no longer need a gate component until their sealed query arrives. The new `keepPreviousData` option keeps returning the rows the hook last rendered when the sealed query changes or is skipped, until the new query has rows of its own, so a growing `LIMIT` or a moved date range no longer empties the list. The result's new `isPlaceholderData` flag is `true` while those earlier rows are shown.
