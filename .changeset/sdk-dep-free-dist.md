---
"@neon/sdk": patch
---

Stop publishing vitest and its transitive dependencies inside the package.

`dist/node_modules/` held 743KB of `vitest`, `chai`, `expect-type`, `loupe` and
`tinyrainbow` — 28% of the unpacked tarball — because `src/neon/client.test-d.ts`
imports `expectTypeOf` and the tsdown `entry` globs excluded only `*.test.ts`, not
`*.test-d.ts`. tsdown externalizes what `dependencies` lists and inlines everything
else, so a devDependency import from any matched file gets copied into the output.
`@neon/sdk` is published as zero-dependency, so nothing belongs there.

The globs now match the exclusions `@neon/config` and `@neon/env` already used, and
`pnpm build` fails if the artifact regresses: `scripts/check-dist.mjs` rejects a
`dist/` that carries bundled dependencies, emitted test files, a non-empty
`dependencies` map, or a bare runtime import a consumer could not resolve.

No API change.
