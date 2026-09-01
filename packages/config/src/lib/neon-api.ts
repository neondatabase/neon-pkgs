import type {
	BucketAccessLevel,
	ComputeSettings,
	CredentialPrincipalType,
	CredentialScope,
	DataApiAuthProvider,
	DataApiSettings,
	FunctionRuntime,
} from "./types.js";

/**
 * Snapshot of a Neon project field set we care about. Maps onto a subset of the upstream
 * `@neondatabase/api-client` `Project` type. We do **not** widen this to the full upstream
 * shape — keeping the surface narrow makes the in-memory fake practical to maintain.
 */
export interface NeonProjectSnapshot {
	id: string;
	name: string;
	regionId: string;
	pgVersion: number;
	orgId?: string;
	defaultEndpointSettings?: ComputeSettings;
}

export interface NeonBranchSnapshot {
	id: string;
	name: string;
	parentId?: string;
	isDefault: boolean;
	/** Whether the branch is marked protected on Neon. */
	protected: boolean;
	expiresAt?: string;
}

export interface NeonEndpointSnapshot {
	id: string;
	branchId: string;
	type: "read_only" | "read_write";
	autoscalingLimitMinCu: ComputeSettings["autoscalingLimitMinCu"];
	autoscalingLimitMaxCu: ComputeSettings["autoscalingLimitMaxCu"];
	suspendTimeout: ComputeSettings["suspendTimeout"];
}

export interface CreateProjectInput {
	name: string;
	regionId: string;
	pgVersion?: number;
	orgId?: string;
	defaultEndpointSettings?: ComputeSettings;
	/**
	 * Optional name for the project's auto-created default branch. When omitted, Neon
	 * uses its own default (`main`).
	 */
	defaultBranchName?: string;
}

export interface CreateBranchInput {
	name: string;
	parentId?: string;
	expiresAt?: string;
	/** When `true`, the branch is created with the `protected` flag set on Neon. */
	protected?: boolean;
	computeSettings?: ComputeSettings;
}

export interface UpdateBranchInput {
	name?: string;
	expiresAt?: string | null;
	/** When set, toggles the branch's `protected` flag on Neon. */
	protected?: boolean;
}

/**
 * A role on a Neon branch (e.g. `neondb_owner`). Passwords are never returned by
 * {@link NeonApi.listBranchRoles}; use {@link NeonApi.getConnectionUri} to fetch a URI
 * with the role's password baked in.
 */
export interface NeonRoleSnapshot {
	name: string;
	branchId: string;
	/** Whether the role is system-protected (cannot be deleted). */
	protected: boolean;
}

/**
 * A database on a Neon branch (e.g. `neondb`).
 */
export interface NeonDatabaseSnapshot {
	name: string;
	branchId: string;
	/** The role that owns the database (one role can own multiple databases). */
	ownerName: string;
}

/**
 * Bits of a Neon Auth integration. The key fields are optional because the Neon API only
 * includes them on create / rotate responses; `GET /auth` returns the public fields.
 */
export interface NeonAuthSnapshot {
	/** The Neon Auth project id (`auth_provider_project_id` on the Neon API). */
	projectId: string;
	/** Public client key (`pub_client_key`), only present on create / rotate responses. */
	publishableClientKey?: string;
	/** Secret server key (`secret_server_key`), only present on create / rotate responses. */
	secretServerKey?: string;
	/** JWKS URL for verifying tokens issued by Neon Auth. */
	jwksUrl: string;
	/** Optional base URL of the Neon Auth deployment. */
	baseUrl?: string;
}

/**
 * Public, fetchable bits of a Neon Data API integration on a specific branch — the subset of
 * the Neon API `DataAPIReponse` we model. `settings` is only populated for SubZero-backed
 * integrations (the API returns `null` otherwise), so it is used for settings-drift diffing
 * when present and ignored when absent.
 */
export interface NeonDataApiSnapshot {
	/** REST endpoint URL. */
	url: string;
	/** Deployment status (e.g. `"ready"`), when reported. */
	status?: string;
	/** Current runtime settings (SubZero only); `null`/absent when not reported. */
	settings?: DataApiSettings | null;
}

/**
 * Input for {@link NeonApi.enableProjectBranchDataApi} — the create-time wiring for a Data
 * API integration (the subset of the Neon API `DataAPICreateRequest` we expose; the
 * `add_default_grants` / `skip_auth_schema` create flags are intentionally not modeled).
 * `authProvider` is the friendly `"neon"` / `"external"` value (mapped to the API's
 * `neon_auth` / `external` by the adapter).
 */
export interface EnableDataApiInput {
	authProvider?: DataApiAuthProvider;
	jwksUrl?: string;
	providerName?: string;
	jwtAudience?: string;
	settings?: DataApiSettings;
}

/**
 * A branchable object-storage bucket (Preview). Backed by Neon's
 * branchable-storage service.
 */
export interface NeonBucketSnapshot {
	name: string;
	accessLevel: BucketAccessLevel;
}

/**
 * S3-compatible connection details for a branch's object storage (Preview) — the
 * `BranchStorage` shape from `GET /projects/{id}/branches/{id}/storage`. Non-secret: it
 * carries the endpoint/region/addressing the S3 SDK needs, while the access keys come from
 * a minted {@link NeonCredentialSecret}. `forcePathStyle` is always `true` today (Neon's
 * wildcard TLS cert puts the branch id in the subdomain, so the bucket must travel in the
 * path).
 */
export interface NeonBranchStorageSnapshot {
	/** S3-compatible endpoint URL, e.g. `https://br-….storage.<suffix>`. */
	s3Endpoint: string;
	/** AWS region string, normalized server-side (e.g. `us-east-2`, `us-east-1`). */
	region: string;
	/** Whether the S3 client must use path-style addressing (always `true` today). */
	forcePathStyle: boolean;
}

/**
 * Input for creating a bucket on a branch.
 */
export interface CreateBucketInput {
	name: string;
	accessLevel?: BucketAccessLevel;
}

/**
 * A Neon Function on a branch (Preview). Mirrors the subset of the Functions API we model:
 * the immutable `slug`, the display `name`, and the active deployment id when one exists.
 */
export interface NeonFunctionSnapshot {
	/** Opaque, stable function identifier. */
	id: string;
	/** Branch-unique slug (the invocation path segment). Immutable. */
	slug: string;
	/** Free-form display name. */
	name: string;
	/** URL at which the function is invoked. */
	invocationUrl: string;
	/** Id (platform version number) of the active deployment, when any code is deployed. */
	activeDeploymentId?: number;
}

/**
 * Input for deploying code to a function. `bundle` is the already-built ZIP archive of the
 * function source — building it (esbuild + zip) is an imperative step performed by the
 * caller, not by the {@link NeonApi} adapter.
 */
export interface DeployFunctionInput {
	bundle: Uint8Array;
	runtime: FunctionRuntime;
	environment: Record<string, string>;
}

/**
 * A function deployment (Preview).
 */
export interface NeonFunctionDeploymentSnapshot {
	/** The deployment id (monotonic per function). */
	id: number;
	status: "pending" | "building" | "completed" | "failed";
}

// ─── Preview: branch-scoped credentials ─────────────────────────────────────

/**
 * Input for {@link NeonApi.createCredential}. Mirrors the Neon API `CreateCredentialRequest`
 * (`POST .../credentials`, `x-stability-level: beta`):
 *
 * - `scopes` — 1–16 capabilities the credential may exercise (derived from the policy's
 *   enabled Preview features, never hand-authored).
 * - `principalType` — `user` (developer/app) or `function` (a deployed function).
 * - `functionId` — required when `principalType === "function"`.
 * - `name` — optional free-form label echoed back on the response.
 */
export interface CreateCredentialInput {
	scopes: CredentialScope[];
	principalType: CredentialPrincipalType;
	functionId?: string;
	name?: string;
}

/**
 * The secret-bearing result of {@link NeonApi.createCredential} — the Neon API
 * `CreateCredentialResponse`. `apiToken` and `s3SecretAccessKey` are returned **exactly
 * once** (they are not stored server-side), so the caller must persist them immediately;
 * they can never be re-fetched (the list endpoint returns metadata only). `tokenIdShort`
 * is the public identifier embedded in `apiToken` (`nt_live_<tokenIdShort>_…`) and doubles
 * as the S3 access-key id.
 */
export interface NeonCredentialSecret {
	tokenId: string;
	tokenIdShort: string;
	name?: string;
	/** Bearer token (`nt_live_…`); returned once. Used for AI Gateway / Functions invoke. */
	apiToken: string;
	/** 64-char hex S3 secret access key; returned once. Paired with `tokenIdShort` as the access-key id. */
	s3SecretAccessKey: string;
	scopes: CredentialScope[];
	branchId: string;
	createdAt: string;
	/** When the credential expires; absent means it never expires. */
	expiresAt?: string;
}

/**
 * Secret-free metadata for an issued credential — the Neon API `CredentialMeta` returned by
 * {@link NeonApi.listCredentials}. Never includes `apiToken` / `s3SecretAccessKey`.
 */
export interface NeonCredentialMeta {
	tokenId: string;
	tokenIdShort: string;
	name?: string;
	scopes: CredentialScope[];
	principalType: CredentialPrincipalType;
	functionId?: string;
	branchId?: string;
	createdAt: string;
	lastUsedAt?: string;
	revokedAt?: string;
	expiresAt?: string;
}

/**
 * Parameters accepted by {@link NeonApi.getConnectionUri}. `branchId` and `endpointId`
 * are optional — when omitted, the API uses the project's default branch and that
 * branch's read-write endpoint, respectively.
 */
export interface GetConnectionUriInput {
	branchId?: string;
	endpointId?: string;
	databaseName: string;
	roleName: string;
	/** When `true`, returns the pooled (PgBouncer) URI instead of the direct URI. */
	pooled?: boolean;
}

/**
 * Narrow façade over the Neon management API. `pullConfig`, `pushConfig`, and `fetchEnv`
 * depend on this interface — *not* on `@neondatabase/api-client` directly — which lets us
 * inject a real in-memory fake during tests without resorting to module mocks.
 */
export interface NeonApi {
	listProjects(filter: { orgId?: string }): Promise<NeonProjectSnapshot[]>;
	getProject(projectId: string): Promise<NeonProjectSnapshot>;
	createProject(input: CreateProjectInput): Promise<NeonProjectSnapshot>;
	updateProject(
		projectId: string,
		input: { name?: string; defaultEndpointSettings?: ComputeSettings },
	): Promise<NeonProjectSnapshot>;

	listBranches(projectId: string): Promise<NeonBranchSnapshot[]>;
	createBranch(
		projectId: string,
		input: CreateBranchInput,
	): Promise<{
		branch: NeonBranchSnapshot;
		endpoints: NeonEndpointSnapshot[];
	}>;
	updateBranch(
		projectId: string,
		branchId: string,
		input: UpdateBranchInput,
	): Promise<NeonBranchSnapshot>;

	listEndpoints(projectId: string): Promise<NeonEndpointSnapshot[]>;
	updateEndpoint(
		projectId: string,
		endpointId: string,
		settings: ComputeSettings,
	): Promise<NeonEndpointSnapshot>;

	/** List roles on a branch. Used by {@link fetchEnv} to auto-pick the role when only one exists. */
	listBranchRoles(
		projectId: string,
		branchId: string,
	): Promise<NeonRoleSnapshot[]>;

	/** List databases on a branch. Used by {@link fetchEnv} to auto-pick the database when only one exists. */
	listBranchDatabases(
		projectId: string,
		branchId: string,
	): Promise<NeonDatabaseSnapshot[]>;

	/**
	 * Fetch a Postgres connection URI for the given role + database on a branch.
	 * Returns the same string the Neon Console shows under "Connection Details".
	 */
	getConnectionUri(
		projectId: string,
		input: GetConnectionUriInput,
	): Promise<{ uri: string }>;

	/**
	 * Fetch the Neon Auth integration attached to a specific branch. Returns `null` when
	 * no integration is enabled — used by `fetchEnv` to decide whether the `env.auth`
	 * namespace can be populated.
	 */
	getNeonAuth(
		projectId: string,
		branchId: string,
	): Promise<NeonAuthSnapshot | null>;

	/**
	 * Enable the Neon Auth integration on a specific branch. Idempotent: if an integration
	 * is already enabled, the existing snapshot is returned unchanged. Used by
	 * `pushConfig` and `branch` to honour branch policy `auth: {}` / `auth.enabled: true`.
	 */
	enableNeonAuth(
		projectId: string,
		branchId: string,
		input?: { databaseName?: string },
	): Promise<NeonAuthSnapshot>;

	/**
	 * Fetch the Neon Data API integration attached to a specific branch + database.
	 * Returns `null` when no integration is enabled — used by `fetchEnv` to decide
	 * whether the `env.dataApi` namespace can be populated.
	 */
	getNeonDataApi(
		projectId: string,
		branchId: string,
		databaseName: string,
	): Promise<NeonDataApiSnapshot | null>;

	/**
	 * Enable the Neon Data API integration on a specific branch + database. Idempotent:
	 * if an integration is already enabled, the existing snapshot is returned unchanged.
	 * Used by `pushConfig` to honour branch policy `dataApi: {}` / `dataApi: { … }`. The
	 * optional {@link EnableDataApiInput} carries the create-time auth wiring + initial
	 * settings; omit it for an all-defaults, Neon-Auth integration.
	 */
	enableProjectBranchDataApi(
		projectId: string,
		branchId: string,
		databaseName: string,
		input?: EnableDataApiInput,
	): Promise<NeonDataApiSnapshot>;

	/**
	 * Update the runtime {@link DataApiSettings} of an already-enabled Data API integration
	 * (the Neon API `PATCH .../data-api/{db}`; always refreshes the schema cache). Only
	 * `settings` are mutable post-create — the auth provider / JWKS wiring is fixed at
	 * enable time. Used by `pushConfig` to reconcile settings drift under `updateExisting`.
	 */
	updateProjectBranchDataApi(
		projectId: string,
		branchId: string,
		databaseName: string,
		settings: DataApiSettings,
	): Promise<NeonDataApiSnapshot>;

	deleteProjectBranchDataApi(
		projectId: string,
		branchId: string,
		databaseName: string,
	): Promise<void>;

	// ─── Preview: buckets ──────────────────────────────────────────────────────

	/** List branchable object-storage buckets visible on a branch. */
	listBranchBuckets(
		projectId: string,
		branchId: string,
	): Promise<NeonBucketSnapshot[]>;

	/** Create a bucket on a branch. Used by `pushConfig` to honour `preview.buckets`. */
	createBranchBucket(
		projectId: string,
		branchId: string,
		input: CreateBucketInput,
	): Promise<NeonBucketSnapshot>;

	/** Delete a bucket from a branch. */
	deleteBranchBucket(
		projectId: string,
		branchId: string,
		bucketName: string,
	): Promise<void>;

	/**
	 * Fetch the branch's S3-compatible object-storage connection details (endpoint, region,
	 * path-style). Returns `null` when storage is not enabled for the branch (the API's 404
	 * `BranchStorageNotEnabled`). Used by `fetchEnv` to populate the `AWS_*` storage env
	 * alongside the minted credential's access keys.
	 */
	getProjectBranchStorage(
		projectId: string,
		branchId: string,
	): Promise<NeonBranchStorageSnapshot | null>;

	// ─── Preview: functions ────────────────────────────────────────────────────

	/** List functions on a branch. */
	listBranchFunctions(
		projectId: string,
		branchId: string,
	): Promise<NeonFunctionSnapshot[]>;

	/** Delete a function (by slug) from a branch. */
	deleteBranchFunction(
		projectId: string,
		branchId: string,
		slug: string,
	): Promise<void>;

	/**
	 * Deploy a built bundle to a function, creating the function if it does not yet exist —
	 * Neon has no separate create endpoint, so the first deployment to a slug creates the
	 * function. The newest deployment becomes active. The `bundle` is built (esbuild + zip)
	 * by the caller and passed in as bytes.
	 */
	deployBranchFunction(
		projectId: string,
		branchId: string,
		slug: string,
		input: DeployFunctionInput,
	): Promise<NeonFunctionDeploymentSnapshot>;

	// ─── Preview: AI Gateway ───────────────────────────────────────────────────
	//
	// The AI Gateway is always available on a branch (credential-gated, not per-branch
	// provisioned): there is no control-plane enable/disable/status route. Declaring
	// `preview.aiGateway` in a policy therefore provisions nothing — it only adds the
	// `ai_gateway:invoke` scope to the branch credential and surfaces the gateway env vars
	// (`NEON_AI_GATEWAY_*`) on `fetchEnv` / `env pull`. So this interface
	// intentionally exposes no AI Gateway methods.

	// ─── Preview: branch-scoped credentials ──────────────────────────────────

	/**
	 * Mint a new scoped service credential on a branch (`POST .../credentials`). The
	 * returned {@link NeonCredentialSecret} carries `apiToken` + `s3SecretAccessKey`
	 * **once** — persist them immediately. Used by `fetchEnv` / `env pull` to issue the
	 * unified credential for the branch's enabled Preview features (object storage, AI
	 * Gateway, Functions).
	 */
	createCredential(
		projectId: string,
		branchId: string,
		input: CreateCredentialInput,
	): Promise<NeonCredentialSecret>;

	/**
	 * List the secret-free metadata for credentials issued on a branch
	 * (`GET .../credentials`). Used to report issued credentials (e.g. `config status`)
	 * and to verify a persisted credential still exists / isn't revoked.
	 */
	listCredentials(
		projectId: string,
		branchId: string,
	): Promise<NeonCredentialMeta[]>;

	/**
	 * Revoke (soft-delete) a credential by its `tokenId` (`DELETE .../credentials/{id}`).
	 * Idempotent.
	 */
	revokeCredential(
		projectId: string,
		branchId: string,
		tokenId: string,
	): Promise<void>;
}
