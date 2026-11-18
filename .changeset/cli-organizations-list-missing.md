---
"neon": patch
---

When a successful organizations lookup returns no organization list, commands now fail with an error naming the request and the response's content type instead of crashing with a TypeError.
