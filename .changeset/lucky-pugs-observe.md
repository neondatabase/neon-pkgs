---
"@neon/config": minor
"@neon/config-runtime": minor
"neon": minor
---

Add `externalPackages` to a `neon.ts` function, for dependencies esbuild cannot bundle

A function's `source` is bundled at deploy time, and some packages cannot be bundled at all: a native `.node` addon has no esbuild loader, and a library may reference an optional peer dependency on a code path the function never takes. Both fail the deploy with a resolve or loader error naming the package, and neither is fixable from the function's own source — there was no way to opt a package out.

`externalPackages` is that escape hatch, and the deploy-time counterpart of Next.js's `serverExternalPackages`:

```ts
export default defineConfig({
  preview: {
    functions: {
      agent: {
        name: "Agent",
        source: "./functions/agent.ts",
        externalPackages: ["microsandbox", "@mongodb-js/zstd"],
      },
    },
  },
});
```

Every entry is passed to esbuild's `external`, so the import survives into the bundle instead of being followed. `neon deploy`, `neon config apply`, `buildFunctionBundle`, and `neon dev` all apply the same list, so a local run bundles like a deploy.

**An external package is not resolvable at runtime.** The deployed archive is a single `index.mjs` with no `node_modules` beside it, so anything listed here throws `Cannot find module` if the function actually reaches it. The option unblocks an import that is never evaluated; it does not make a dependency usable. A dependency the handler actually calls has to be bundled — which a pure-JavaScript package can be, and a package backed by a native `.node` binary cannot, by any bundler.

Entries are package names, optionally with a subpath (`pkg`, `@scope/pkg`, `pkg/sub`). A relative or absolute path is rejected at validation time.
