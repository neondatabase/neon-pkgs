/**
 * The raw, generated 1:1 surface — every endpoint as a standalone function plus the
 * client primitives. Reachable as a namespace (`import { raw } from "@neon/sdk"`) or, for
 * guaranteed per-function tree-shaking, via this subpath:
 * `import { listProjects } from "@neon/sdk/raw"`.
 */

// `ClientOptions` / `Options` are intentionally not re-exported from the client
// primitives — the Neon API spec defines its own types with those names, which the
// `export *` above already provides.
export {
	type Client,
	type Config,
	type CreateClientConfig,
	createClient,
	createConfig,
} from "./client/client/index.js";
export { client } from "./client/client.gen.js";
export * from "./client/index.js";
