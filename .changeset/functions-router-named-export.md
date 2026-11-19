---
"neon": patch
---

The router `index.ts` that `neon functions new` writes now names its default export (`export default handler;`), so Next.js's ESLint config no longer warns on it with `import/no-anonymous-default-export`.
