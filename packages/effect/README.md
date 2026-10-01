# `@neon/effect`

Effect v4 bindings for the [`@neon/sdk`](../sdk/README.md) ergonomic client (`createNeonClient`). API calls return Effects, paginated lists return Streams and SDK errors have tags for `Effect.catchTag`. Interrupting a fiber cancels its HTTP request and readiness polling.

```bash
npm install @neon/effect effect
```

Requires Effect v4.

## Quick start

Set `NEON_API_KEY` and optionally `NEON_ORG_ID`, then provide `layerConfig`:

```ts
import { Neon, layerConfig } from "@neon/effect";
import { Effect, Stream } from "effect";

const program = Effect.gen(function* () {
  const neon = yield* Neon;
  const projects = yield* neon.projects.list().pipe(
    Stream.take(10),
    Stream.runCollect,
  );
  const project = yield* neon.projects.get({
    projectId: "my-project-id",
  }).pipe(
    Effect.catchTag("NeonNotFoundError", () => Effect.succeed(undefined)),
  );
  return { projects, project };
});

Effect.runPromise(program.pipe(Effect.provide(layerConfig)));
```

## Configuration

`Neon` is a `Context.Service` whose value is a `NeonEffectClient`.

| Export | Behavior |
| --- | --- |
| `layer(config)` | Provides `Neon` from explicit configuration. Reads no environment variables. Fails with `NeonClientError` on invalid configuration. |
| `layerConfig` | Provides `Neon` through Effect Config. Reads required `NEON_API_KEY` with `Config.Redacted` and optional `NEON_ORG_ID` as the default organization. Fails with `NeonClientError` or `ConfigError`. |
| `make(config)` | Returns a `NeonEffectClient` directly, without a network request. Throws `NeonClientError` on invalid configuration. |

`NeonEffectConfig` accepts the SDK's [client configuration](../sdk/README.md#client-configuration), excluding `throwOnError`: `apiKey` (string or sync/async function), `orgId`, `baseUrl`, `fetch`, `retries`, `requestTimeoutMs`, `waitForReadiness` and `wait`.

Explicit configuration for the program above:

```ts
import { layer, make } from "@neon/effect";

const apiKey = process.env.NEON_API_KEY;
if (!apiKey) throw new Error("NEON_API_KEY is required");

const config = { apiKey, requestTimeoutMs: 10_000 };

Effect.runPromise(program.pipe(Effect.provide(layer(config))));

const neon = make(config);
await Effect.runPromise(
  neon.projects.get({ projectId: "my-project-id" }),
);
```

An empty `apiKey` or invalid `retries` or `requestTimeoutMs` fails configuration validation. `@neon/sdk` is installed as a dependency.

## Methods and pagination

Method names and named parameters follow the [SDK API reference](../sdk/README.md#api-reference). Each method accepts its SDK per-call options as the last argument, excluding `signal` and `throwOnError`.

```ts
neon.projects.list(undefined, { requestTimeoutMs: 5_000 });
neon.user.me({ requestTimeoutMs: 5_000 });
neon.branches.create(
  { projectId, name: "preview" },
  { waitForReadiness: true },
);
neon.operations.waitFor(
  { operations },
  { timeoutMs: 30_000, pollIntervalMs: 250 },
);
```

These paginated methods return `Stream<Item, NeonEffectError>`:

- `projects.list`, `projects.members.list`
- `branches.list`, `operations.list`
- `functions.list`, `functions.customDomains.list`
- `logs.query`
- `consumption.perProject`, `consumption.perProjectV2`, `consumption.perBranchV2`

Every other method returns `Effect<T, NeonEffectError>`, including array results such as `regions.list` and `postgres.roles.list`. Successful Effects yield the SDK resource directly.

Retries for `423`, `429` and `503` (including `Retry-After` handling), readiness polling, `createAndConnect` and connection-string resolution run through the SDK unchanged.

## Errors

`NeonEffectError` is the union of the exported tagged error classes below. Each class's `_tag` matches its name. Every error has `message` and `cause`, the original `@neon/sdk` error.

| Class / `_tag` | Fields |
| --- | --- |
| `NeonApiError` | `status`, `code`, `requestId`, `response`, `body` |
| `NeonNotFoundError` | Same HTTP fields; 404 |
| `NeonAuthError` | Same HTTP fields; 401/403 |
| `NeonRateLimitError` | Same HTTP fields; 429 after retries |
| `NeonOperationError` | `operationId`, `status` |
| `NeonRequestTimeoutError` | `timeoutMs` |
| `NeonWaitTimeoutError` | `timeoutMs`, `operations` |
| `NeonNetworkError` | `reason` |
| `NeonClientError` | `message`, `cause` |

A wait timeout means the mutation was accepted. Continue waiting on its outstanding operations:

```ts
const createBranch = Effect.gen(function* () {
  const neon = yield* Neon;
  return yield* neon.branches.create(
    { projectId: "my-project-id", name: "preview" },
    { wait: { timeoutMs: 30_000 } },
  ).pipe(
    Effect.catchTag("NeonWaitTimeoutError", (error) =>
      neon.operations.waitFor({ operations: error.operations }),
    ),
  );
});

Effect.runPromise(createBranch.pipe(Effect.provide(layerConfig)));
```

The recovery path returns `void` when waiting completes. Exceptions outside the SDK error hierarchy become Effect defects. Cancellation interrupts the fiber; the SDK's `aborted` error kind has no tagged counterpart.

## Cancellation and deadlines

Interruption through `Effect.timeout`, `Fiber.interrupt`, `Effect.race` or scope closure for scoped fibers aborts the in-flight request and stops readiness polling. Each Stream page uses the signal of the Effect that pulls it.

`requestTimeoutMs` bounds each HTTP request and its retries. For a Stream, that budget applies to each page. The SDK's `.all()` instead uses one deadline for the entire walk. To bound whole-Stream consumption, apply `Effect.timeout`:

```ts
const projects = Effect.gen(function* () {
  const neon = yield* Neon;
  return yield* neon.projects
    .list(undefined, { requestTimeoutMs: 5_000 })
    .pipe(
      Stream.runCollect,
      Effect.timeout("30 seconds"),
    );
});

Effect.runPromise(projects.pipe(Effect.provide(layerConfig)));
```

## Development

From the repository root:

```bash
pnpm --filter @neon/effect build
pnpm --filter @neon/effect test
pnpm --filter @neon/effect test:e2e
```

Live e2e tests need credentials in the root `.env` for a dedicated throwaway organization. See [CONTRIBUTING.md](../../CONTRIBUTING.md#live-neon-e2e-tests).

## License

Apache-2.0
