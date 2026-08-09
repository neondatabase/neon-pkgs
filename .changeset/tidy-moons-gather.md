---
"@neon/config": minor
---

**Breaking:** `externalPackages` now ships a package's real files into the deployed archive
by default, instead of externalizing the import and shipping nothing.

A bare string is the common form and produces a function that works:

```ts
externalPackages: ["sharp"],
```

The previous behaviour — externalize the import, ship nothing, throw `Cannot find module`
if the function reaches it — is now the opt-out, for a package that cannot be staged and is
never actually reached:

```ts
externalPackages: ["sharp", { name: "canvas", includeFiles: false }],
```

`ResolvedFunctionConfig.externalPackages` changes from `string[]` to
`{ name: string; includeFiles: boolean }[]`, which affects anything reading a resolved
config or implementing a custom `FunctionBundler`. Two pure helpers are exported for that
case: `packagesToStage` and `externalPackageRoot`.

A function that declares no `externalPackages`, or whose every entry sets
`includeFiles: false`, deploys exactly the archive it did before.

A package named here must be installed in your project: the deploy stages the version you
have rather than guessing one, and refuses if it cannot find it.

Validation additionally rejects the same package listed twice, a bare name and a subpath of it
that disagree about `includeFiles`, and an entry that does not name one installable package
(a wildcard or a bare scope) unless it sets `includeFiles: false`.
