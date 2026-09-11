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
	isNeonError,
	NeonAbortError,
	NeonApiError,
	type NeonApiErrorKind,
	NeonAuthError,
	NeonClientError,
	NeonError,
	type NeonErrorKind,
	type NeonErrorUnion,
	NeonNetworkError,
	NeonNotFoundError,
	NeonOperationError,
	NeonRateLimitError,
	NeonRequestTimeoutError,
	NeonTimeoutError,
	NeonWaitTimeoutError,
} from "./neon/errors.js";
export type { Page, Paginated } from "./neon/paginate.js";
// Named operation parameter types.
export type {
	ApiKeysCreateParams,
	ApiKeysRevokeParams,
} from "./neon/resources/account.js";
export type { AiGatewayGetParams } from "./neon/resources/ai-gateway.js";
export type {
	AuthCreateParams,
	AuthDisableParams,
	AuthGetParams,
	AuthOauthProvidersAddParams,
	AuthOauthProvidersDeleteParams,
	AuthOauthProvidersListParams,
	AuthOauthProvidersUpdateParams,
	AuthTrustedDomainsAddParams,
	AuthTrustedDomainsDeleteParams,
	AuthTrustedDomainsListParams,
	AuthUpdateConfigParams,
	AuthUsersCreateParams,
	AuthUsersDeleteParams,
	AuthUsersUpdateRoleParams,
} from "./neon/resources/auth.js";
export type {
	BranchCompareSchemaParams,
	BranchConnection,
	BranchCreateAndConnectParams,
	BranchCreateParams,
	BranchDeleteParams,
	BranchFinalizeRestoreParams,
	BranchGetDefaultParams,
	BranchGetParams,
	BranchListParams,
	BranchResetFromParentParams,
	BranchSetDefaultParams,
	BranchUpdateParams,
	CompareSchemaInput,
	ComputeSettings,
	CreateAndConnectInput,
	ResetFromParentInput,
} from "./neon/resources/branches.js";
export type {
	BucketObjectsDeleteByPrefixParams,
	BucketObjectsDeleteParams,
	BucketObjectsGetParams,
	BucketObjectsListParams,
	BucketObjectsPresignParams,
} from "./neon/resources/bucket-objects.js";
export type {
	BucketsCreateParams,
	BucketsDeleteParams,
	BucketsListParams,
} from "./neon/resources/buckets.js";
export type {
	CredentialsCreateParams,
	CredentialsListParams,
	CredentialsRevealParams,
	CredentialsRevokeParams,
	CredentialsRotateParams,
} from "./neon/resources/credentials.js";
export type {
	CustomDomainsDeleteParams,
	CustomDomainsListParams,
	CustomDomainsRegisterParams,
} from "./neon/resources/custom-domains.js";
export type {
	DataApiCreateParams,
	DataApiDeleteParams,
	DataApiGetParams,
	DataApiUpdateParams,
} from "./neon/resources/dataapi.js";
export type {
	DatabasesCreateParams,
	DatabasesDeleteParams,
	DatabasesGetParams,
	DatabasesListParams,
	DatabasesUpdateParams,
} from "./neon/resources/databases.js";
export type {
	EndpointsCreateParams,
	EndpointsDeleteParams,
	EndpointsGetParams,
	EndpointsListByBranchParams,
	EndpointsListParams,
	EndpointsRestartParams,
	EndpointsStartParams,
	EndpointsSuspendParams,
	EndpointsUpdateParams,
} from "./neon/resources/endpoints.js";
export type {
	FunctionsDeleteParams,
	FunctionsDeployParams,
	FunctionsGetParams,
	FunctionsListParams,
	FunctionsUpdateParams,
} from "./neon/resources/functions.js";
export type {
	LogFieldValuesQuery,
	LogQueryInput,
	LogsFieldsParams,
	LogsFieldValuesParams,
	LogsQueryParams,
} from "./neon/resources/logs.js";
export type {
	OperationsGetParams,
	OperationsListParams,
	OperationsWaitForParams,
} from "./neon/resources/operations.js";
export type { ConnectionStringParams } from "./neon/resources/postgres.js";
export type {
	ProjectConnection,
	ProjectCreateAndConnectParams,
	ProjectCreateParams,
	ProjectDeleteParams,
	ProjectGetParams,
	ProjectListParams,
	ProjectMemberListParams,
	ProjectMemberRemoveRoleParams,
	ProjectMemberSetRoleParams,
	ProjectPermissionGrantParams,
	ProjectPermissionListParams,
	ProjectPermissionRevokeParams,
	ProjectRecoverParams,
	ProjectTransferFromUserParams,
	ProjectTransferParams,
	ProjectUpdateParams,
	RemoveRoleOptions,
	SetRoleOptions,
	TransferProjectsInput,
} from "./neon/resources/projects.js";
export type {
	RolesCreateParams,
	RolesDeleteParams,
	RolesGetParams,
	RolesListParams,
	RolesPasswordParams,
	RolesResetPasswordParams,
} from "./neon/resources/roles.js";
export type {
	BackupScheduleItemInput,
	CreateSnapshotInput,
	RestorePreview,
	RestoreSnapshotInput,
	SetScheduleInput,
	SnapshotFrequency,
	SnapshotsCreateParams,
	SnapshotsDeleteParams,
	SnapshotsGetScheduleParams,
	SnapshotsListParams,
	SnapshotsRestoreParams,
	SnapshotsSetScheduleParams,
	SnapshotsUpdateParams,
	UpdateSnapshotInput,
} from "./neon/resources/snapshots.js";
export type { StorageGetParams } from "./neon/resources/storage.js";
export type {
	TriggersCreateParams,
	TriggersDeleteParams,
	TriggersGetParams,
	TriggersListParams,
	TriggersUpdateParams,
} from "./neon/resources/triggers.js";
export type { NeonResult, Outcome } from "./neon/result.js";
export type { WaitBudget, WaitForOptions } from "./neon/wait.js";
export type * from "./raw.js";
// The raw 1:1 surface as a namespace, and all generated types flat.
export * as raw from "./raw.js";
