# Contributing to `@neon/env`

General setup, the Node floors, and how to run the live e2e suites live in the
[repo-root `CONTRIBUTING.md`](../../CONTRIBUTING.md). This file covers the one thing about this
package you have to get right before adding anything to it: **whether your code belongs on the
published surface at all, or in the shared tree the CLIs compile in.**

## One entry point, and what deliberately isn't on it

Everything `@neon/env` publishes is on `src/index.ts`, and all of it is side-effect-free: it
reads no files, no env source, and mutates nothing. That property is what lets an app, a build
script, or a `neon.ts` policy import this package without wondering what else it might touch.
Keep it that way.

### Why `fetchEnvReusingSecrets` is not here

The awkward part of `fetchEnv` is that one of the values it returns cannot actually be
*fetched*. The Neon API issues a branch credential's `api_token` and `s3_secret_access_key`
**exactly once**, at mint time — they are not stored server-side, and the credentials list
endpoint returns metadata only. So "fetch me the storage secrets" means "mint a new
credential", and a tool that resolves the same branch on every `neon dev` start, `link`,
`checkout`, and `env pull` would leave a live credential behind each time.

Avoiding that requires state: you have to look at the secrets a previous run persisted, work out
whether they are still usable, and revoke the ones you supersede. That is a genuinely different
kind of operation, and `fetchEnvReusingSecrets` is where it lives — in
[`shared/env-core`](../../shared/env-core), compiled into this package and into the `neon` CLI
as their own source.

It was published as `@neon/env/runtime` until 0.16.0. That was the wrong shape: its only
consumers are our own two CLIs, and a library that revokes your credentials because you imported
it is a library you cannot safely embed. A subpath export was a way of moving code between two
packages in this repo, and shared source is what that actually is.

**So: if your change needs an env source, a file path, a previous run's output, or a decision
about creating or destroying something remote, it belongs in `shared/env-core`, not here.** If
you find yourself widening this package's exports so `packages/cli` can reach an internal, stop
— that is the signal the code belongs in the shared tree instead.

### What lives where

| Location | Holds | May it read an env source or mutate anything remote? |
| --- | --- | --- |
| `shared/env-core/src/env.ts` | `fetchEnv`, `NEON_ENV_VAR_KEYS`, the `NeonEnv` shapes, `toEntries` | No |
| `shared/env-core/src/reuse-secrets.ts` | `fetchEnvReusingSecrets` | Yes — mints and revokes branch credentials |
| `packages/env/src/lib/parse-env.ts` | `parseEnv` and its zod schemas | Reads `process.env`, mutates nothing |
| `packages/env/src/index.ts` | The published surface: re-exports the pure parts of the two above | No |

`parseEnv` stays in this package rather than moving to the shared tree because nothing else
needs it — the `neon` CLI resolves env from the API and injects it, and never reads it back.
That also keeps `zod` out of the shared tree, and so out of every consumer that copies it.

One contract test in `src/lib/env.contract.test.ts` pins this: an inline snapshot of the entry
point's exports (so removing or renaming one is a visible breaking change), an assertion that
`fetchEnvReusingSecrets` never appears on it, and an assertion that `package.json` `exports` has
exactly one key.

## Consumers of the shared tree

Changing `shared/env-core` is not free — these all have to keep working:

| Consumer | Uses it for |
| --- | --- |
| `@neon/env` itself | `fetchEnv` / `toEntries`, re-exported from `src/index.ts` |
| `neon-env run` / `neon-env export` (`src/lib/cli/`) | Injecting a branch's env into a subprocess without minting a credential per invocation |
| `neon env pull`, `neon dev`, `neon link`, `neon checkout` (`packages/cli/src/dev/env.ts`) | The shared tiered resolver behind all four |

`scripts/sync-shared.mjs` copies it into `packages/{cli,env}/src/_shared/env-core/` before
either builds; that copy is gitignored. **Edit `shared/env-core/src`, never the copy.** Any
script that reads a consumer's `src/` has to run the sync first, or it compiles a stale tree.

`@neon/config` is the only dependency the shared tree may take — both consumers already have
it. Anything else becomes a runtime dependency of both.

## The branch credential, in one place

Everything that knows how a branch credential works lives in
`shared/env-core/src/reuse-secrets.ts`. The
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

The call signature, since it is no longer documented anywhere a consumer can read:

```ts
const { vars, credential } = await fetchEnvReusingSecrets(config, {
    projectId,
    branch: "main",
    env: { ...process.env, ...readEnvFile(".env") },
    revokeSuperseded: false, // default: true
});

// credential.issued     — a new credential was minted
// credential.keys       — the env vars its secrets surface under
// credential.revoked    — ids it replaced and revoked
// credential.superseded — ids it replaced but left live (`revokeSuperseded: false`)
```

`revokeSuperseded: false` is for a caller resolving a **subset** of a branch: object storage and
the AI Gateway share one credential, so revoking the one your persisted secrets name can break a
service the call is not rewriting. The cost is an orphaned credential, which is the safer of the
two failures, and `credential.superseded` names it so the caller can report it rather than leave
it invisible. `neon env pull --service` is why it exists.


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
