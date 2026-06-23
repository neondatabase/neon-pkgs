# @neondatabase/sdk

The official TypeScript SDK for the [Neon API](https://api-docs.neon.tech/reference) — a modern, Fetch-based client generated from Neon's [OpenAPI specification](https://neon.com/api_spec/release/v2.json).

This is the successor to [`@neondatabase/api-client`](https://www.npmjs.com/package/@neondatabase/api-client). It drops the `axios` dependency in favor of the platform `fetch`, so it runs unchanged on Node.js, Bun, Deno, edge runtimes, and the browser, and every endpoint is exposed as an individually importable, tree-shakeable function.

## Install

```bash
npm install @neondatabase/sdk
```

Requires Node.js >= 22 (or any runtime with a global `fetch`).

## Usage

Get an API key from the [Neon Console](https://console.neon.tech/app/settings#api-keys), then configure the default client and call any endpoint:

```ts
import { client, listProjects } from "@neondatabase/sdk";

client.setConfig({
	auth: () => process.env.NEON_API_KEY,
});

const { data, error } = await listProjects();
if (error) {
	throw new Error(`Neon API error: ${JSON.stringify(error)}`);
}
console.log(data.projects);
```

Each call returns `{ data, error, request, response }` by default — no `try/catch` required for HTTP errors. Pass `throwOnError: true` (per call or on the client) if you prefer exceptions.

### Per-call options

Path parameters, query parameters, and request bodies are fully typed per endpoint:

```ts
import { createProject, getProject } from "@neondatabase/sdk";

const created = await createProject({
	body: { project: { name: "my-app", region_id: "aws-us-east-1" } },
});

const project = await getProject({
	path: { project_id: created.data!.project.id },
});
```

### Isolated clients

`client.setConfig` mutates a shared default client. To run multiple independent
configurations (different keys, base URLs, or a custom `fetch`), create your own client
and pass it per call:

```ts
import { createClient, createConfig, listProjects } from "@neondatabase/sdk";

const myClient = createClient(
	createConfig({
		auth: () => process.env.NEON_API_KEY,
		baseUrl: "https://console.neon.tech/api/v2",
	}),
);

const { data } = await listProjects({ client: myClient });
```

## What's exported

This package re-exports the full generated surface from a single entry point:

- **Endpoint functions** — one per operation (`listProjects`, `createProject`, `createProjectBranch`, `getConnectionUri`, …).
- **Types** — every request, response, and error shape (`Project`, `Branch`, `Endpoint`, `CreateProjectData`, …).
- **Client primitives** — `createClient`, `createConfig`, and the preconfigured default `client` (base URL `https://console.neon.tech/api/v2`).

## Regenerating the client

The client is generated from a vendored, pinned copy of the spec in [`spec/neon-openapi.json`](./spec/neon-openapi.json) using [`@hey-api/openapi-ts`](https://heyapi.dev).

```bash
pnpm --filter @neondatabase/sdk spec:pull   # refresh the vendored spec from neon.com
pnpm --filter @neondatabase/sdk generate     # regenerate src/client
pnpm --filter @neondatabase/sdk build        # typecheck + bundle
```

## License

Apache-2.0
