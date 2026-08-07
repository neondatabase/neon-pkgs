---
"@neon/config-runtime": minor
"neon": minor
---

Stage the real files of a function's `externalPackages` into the deployed archive, so a
package backed by a native binary works on Functions instead of failing at invoke. Each
declared package is installed for the runtime target (linux-arm64, glibc) into a throwaway
directory, traced for the files it actually reaches, and copied under `node_modules/` with
its directory layout preserved. The user's own `node_modules` is never read for those files
or modified.

An entry with `includeFiles: false` is externalized and nothing is staged for it, which is
the pre-existing behaviour. A function whose entries all opt out — or which declares none —
produces a byte-identical archive to before.

Deploys and `neon dev` now report a package that was bundled in, carries native code, and
was never declared. The report is advisory and never fails a deploy: the evidence shows the
package contains compiled code, not that this function reaches it, and a package with a
working JavaScript fallback looks identical.

Fixes version pinning for packages whose `exports` map does not list `./package.json`.
`sharp` is one, so the version the user had installed was never read and the registry's
latest was staged instead. Versions are now read from the package directory rather than
through the resolver, and a package whose version still cannot be determined is reported
instead of being staged silently.
