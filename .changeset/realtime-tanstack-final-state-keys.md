---
"@neon/realtime-tanstack": patch
---

Check collection keys against each Realtime update's final state. An update in which rows exchange the values `getKey` reads, such as one that renumbers rows, no longer fails with "upserted an existing key"; only a key that two rows still own after the whole update is rejected. Each update's work is now proportional to its changes rather than to the collection's size.
