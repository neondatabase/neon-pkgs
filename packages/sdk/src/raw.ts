/**
 * The raw, 1:1 surface — every endpoint as a standalone function plus the client
 * primitives. Reachable as a namespace (`import { raw } from "@neon/sdk"`) or, for
 * guaranteed per-function tree-shaking, via this subpath:
 * `import { listProjects } from "@neon/sdk/raw"`.
 *
 * Every operation speaks the **same result contract as the ergonomic client**: it resolves
 * to a `{ data, error }` {@link NeonResult} by default, or the bare resource when you pass
 * `throwOnError: true` (throwing a `NeonErrorUnion` member). There is no `responseStyle` switch —
 * `throwOnError` is the only one, and the return type always tracks it.
 */

// `ClientOptions` / `Options` are intentionally not re-exported from the client
// primitives — the Neon API spec defines its own types with those names, which the
// `export type *` below already provides.
export {
	type Client,
	type Config,
	type CreateClientConfig,
	createClient,
	createConfig,
} from "./client/client/index.js";
export { client } from "./client/client.gen.js";
// Every operation, wrapped to the ergonomic result contract.
export * from "./client/raw.gen.js";
// Every generated request/response/schema type, flat.
export type * from "./client/types.gen.js";
// The wrapper primitive, for advanced users composing their own raw calls.
export {
	type RawData,
	type RawOptions,
	type RawResult,
	wrapRaw,
} from "./neon/raw-wrap.js";
