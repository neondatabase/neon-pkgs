# Contributing to `@neon/env`

General setup, the Node floors, and how to run the live e2e suites live in the
[repo-root `CONTRIBUTING.md`](../../CONTRIBUTING.md). This file covers the one thing about this
package you have to get right before adding anything to it: **which of the two entry points your
code belongs in.**

## Two entry points, and the line between them

| Entry point | Audience | May it read `process.env`, a file, or mutate anything remote? |
| --- | --- | --- |
| `@neon/env` (`src/index.ts`) | **Developers consuming the package** — an app, a build script, a Drizzle config, a `neon.ts` policy | **No** |
| `@neon/env/runtime` (`src/runtime.ts`) | **Our own tooling** — the `neon-env` CLI in this package, the `neon` CLI in `packages/cli`, and anything else that resolves the same branch repeatedly | Yes |

Both are declared in `package.json` `exports` and both are checked by the `Check @neon/env
distributed types` CI job (`attw --pack`). Adding a symbol to an existing entry point means
editing that one `src` file; adding a *third* entry point means editing `package.json` `exports`
and `tsdown.config.ts`'s `entry` list too, or it won't be built.

### Why the split exists

`fetchEnv` is a pure question: *what env does this branch have?* It takes an explicit
`projectId` and `branch`, calls the Neon API, and returns the answer. It reads no env source and
no file. That property is what lets an app or build script call it without wondering what else it
might touch.

The awkward part is that one of the values it returns cannot actually be *fetched*. The Neon API
issues a branch credential's `api_token` and `s3_secret_access_key` **exactly once**, at mint
time — they are not stored server-side, and the credentials list endpoint returns metadata only.
So "fetch me the storage secrets" means "mint a new credential", and a tool that resolves the
same branch on every `neon dev` start, `link`, `checkout`, and `env pull` would leave a live
credential behind each time.

Avoiding that requires state: you have to look at the secrets a previous run persisted, work out
whether they are still usable, and revoke the ones you supersede. That is a genuinely different
kind of operation, and `fetchEnvReusingSecrets` is where it lives.

Keeping the two apart by import path means a consumer cannot accidentally pick up the version
that reads their `.env` and revokes credentials. It is the same split, for the same reason, as
[`@neon/config`](../config) (pure policy types and diffing) versus
[`@neon/config-runtime`](../config-runtime) (`inspect` / `plan` / `apply`, which do I/O).

### Where does my change go?

Ask what the code needs in order to work:

- Only `config` plus explicit arguments, and it returns a value derived from the Neon API →
  **`@neon/env`**.
- An env source, a file path, a previous run's output, or a decision about creating or destroying
  something remote → **`@neon/env/runtime`**.

If a helper in `src/lib/` is used by both, leave it unexported from either entry file. Module
exports inside `src/lib/` are invisible to consumers because `package.json` only maps `.` and
`./runtime`, so package-internal sharing costs nothing — this is why the reuse logic stays in
this package rather than moving into `packages/cli`. `neon-env run` needs it too, and a helper
shared between the two entry points doesn't have to become public API to be shared.

Two contract tests in `src/lib/env.contract.test.ts` pin this:

- an inline snapshot of each entry point's exports, so removing or renaming one is a visible
  breaking change, and
- an assertion that `fetchEnvReusingSecrets` never appears on the root export.

If you find yourself needing to widen the root export so that `packages/cli` can reach an
internal, stop: that is the signal the code belongs in `runtime` instead.

## Consumers of the `runtime` entry

Adding to `runtime` is not free — these all have to keep working:

| Consumer | Uses it for |
| --- | --- |
| `neon-env run` / `neon-env export` (`src/lib/cli/`) | Injecting a branch's env into a subprocess without minting a credential per invocation |
| `neon env pull`, `neon dev`, `neon link`, `neon checkout` (`packages/cli/src/dev/env.ts`) | The shared tiered resolver behind all four |

`packages/cli` is on classic `moduleResolution: node`, which **ignores package `exports`**. A new
subpath therefore needs a `paths` entry in `packages/cli/tsconfig.json` for the type-checker;
Node honours the real export map at runtime. `@neon/sdk/raw` has the same treatment. Because that mapping only satisfies `tsc`, verify a new subpath actually resolves
from the built artifact rather than trusting a green test run:

```bash
pnpm --filter @neon/env build
node -e "import('./packages/cli/dist/dev/env.js').then(() => console.log('ok'))"
pnpm exec attw --pack packages/env --profile esm-only
```

## The branch credential, in one place

Everything that knows how a branch credential works lives in `src/lib/reuse-secrets.ts`. The
facts worth knowing before you touch it:

- **`AWS_ACCESS_KEY_ID` is the credential's `tokenId`.** The full id, not `tokenIdShort` — the
  storage gateway rejects the short one with `InvalidAccessKeyId`.
- **The AI Gateway token embeds its own id**, as `nt_live_<tokenIdShort>_<secret>`.

Together those mean a persisted `.env` already records which credential issued it, so verifying
and superseding a credential needs **no local bookkeeping** — no extra field in `.neon`, no
sidecar file. Don't add one.

- **Reuse is verified, not assumed.** A persisted secret is kept only when it names a credential
  that still exists on the branch, is not revoked or expired, and carries every scope the policy
  needs. A presence check is not enough: it cannot tell a real secret from a `.env.example`
  placeholder.
- **Revocation is deliberately narrow.** Only credentials the persisted secrets named, and only
  those minted under this package's own `neon-env <branch>` name. Anything else may belong to a
  teammate, another checkout, or a deployed function, and nothing observable distinguishes those
  from an orphan of our own. Widening this needs a very good argument.

## Testing this package

```bash
pnpm --filter @neon/env test       # builds workspace deps first, then Vitest
pnpm --filter @neon/env test:types # type-level tests (env.test-d.ts)
pnpm --filter @neon/env test:e2e   # live Neon API — see the root CONTRIBUTING.md
```

`src/lib/fake-neon-api.ts` is a real in-memory implementation of the `NeonApi` interface, not a
mock — tests drive it end to end and assert on `api.history`. Prefer extending it over stubbing a
method, and when you add behaviour to it, make it behave like the real API: it once minted the
same `tokenIdShort` for every credential, which no test could catch until something looked a
credential up by id.

Adding a var to `NEON_ENV_VAR_KEYS` touches more than it looks like: `EnvKeysByNamespace`,
`NamespaceEnv`, `EnvKeyToProp`, `FILTERABLE_ENV_KEYS`, `policyEnvKeys`, `toEntries`, the
`parseEnv` reader, and the README's "Env vars produced" table. The contract and completions tests
will tell you which ones you missed.
