---
"@neon/realtime": patch
"@neon/realtime-react": patch
"@neon/realtime-tanstack": patch
---

Infer live rows from the sealed query instead of weakening the result type to accept incompatible initial data or refresh callbacks. Keep contextual row and collection-key inference, using a compatibility helper rather than requiring TypeScript 5.4's built-in NoInfer.
