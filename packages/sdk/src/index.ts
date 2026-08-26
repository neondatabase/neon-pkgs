/**
 * `@neon/sdk` — the official TypeScript SDK for the Neon API.
 *
 * Two layers, one package:
 *
 * - **`createNeonClient`** — the ergonomic client. Auth once, `{ data, error }` results
 *   (or `throwOnError`), retries, readiness polling, auto-pagination, and typed errors,
 *   organized into resource namespaces (`neon.projects.*`, `neon.operations.*`, …).
 * - **`raw`** — the full generated 1:1 surface (every endpoint as a standalone,
 *   tree-shakeable function + client primitives). Also at the `@neon/sdk/raw` subpath.
 *
 * All request/response/error types are re-exported flat for `import type { … }`.
 *
 * @example
 * ```ts
 * import { createNeonClient } from "@neon/sdk";
 *
 * const neon = createNeonClient({ apiKey: process.env.NEON_API_KEY! });
 * const { data, error } = await neon.projects.list().all();
 * ```
 */

export type { NeonClient } from "./neon/client.js";
export { createNeonClient } from "./neon/client.js";
export type { NeonConfig } from "./neon/config.js";
export type { CallOptions } from "./neon/context.js";
export {
	NeonAbortError,
	NeonApiError,
	NeonAuthError,
	NeonError,
	type NeonErrorKind,
	NeonNetworkError,
	NeonNotFoundError,
	NeonOperationError,
	NeonRateLimitError,
	NeonTimeoutError,
} from "./neon/errors.js";
export type { Page, Paginated } from "./neon/paginate.js";
export type {
	BranchConnection,
	CompareSchemaInput,
	ComputeSettings,
	CreateAndConnectInput,
	ResetFromParentInput,
} from "./neon/resources/branches.js";
export type {
	LogFieldValuesQuery,
	LogQueryInput,
} from "./neon/resources/logs.js";
export type { ConnectionStringParams } from "./neon/resources/postgres.js";
export type {
	ProjectConnection,
	RemoveRoleOptions,
	SetRoleOptions,
	TransferProjectsInput,
} from "./neon/resources/projects.js";
export type {
	BackupScheduleItemInput,
	CreateSnapshotInput,
	RestorePreview,
	RestoreSnapshotInput,
	SetScheduleInput,
	SnapshotFrequency,
	UpdateSnapshotInput,
} from "./neon/resources/snapshots.js";
export type { NeonResult, Outcome } from "./neon/result.js";
export type { WaitForOptions } from "./neon/wait.js";
export type * from "./raw.js";
// The raw 1:1 surface as a namespace, and all generated types flat.
export * as raw from "./raw.js";
