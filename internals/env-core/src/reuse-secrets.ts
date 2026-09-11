import {
	type Config,
	type CredentialScope,
	credentialScopesSatisfied,
	type NeonCredentialMeta,
} from "@neon/config/v1";

import {
	createApiFromOptions,
	credentialEnvKeys,
	credentialName,
	defaultAiGatewayCredential,
	defaultStorageCredential,
	type FetchEnvKeysOptions,
	type FetchEnvOptions,
	type FunctionUrlMode,
	fetchEnvKeysState,
	isFunctionBaseUrlKey,
	isLiveCredential,
	NEON_ENV_VAR_KEYS,
	policyEnvKeys,
	resolveBranchPolicy,
	toEntries,
} from "./env.js";

/**
 * What happened to the branch credential during a {@link fetchEnvReusingSecrets} call.
 */
export interface CredentialOutcome {
	/**
	 * `true` when secrets were revealed or minted this call — because none were persisted, or
	 * because the persisted secrets could not be verified as the platform defaults (or, with
	 * no defaults, as a still-live minted credential). `false` when the persisted secrets
	 * were verified and kept, and when the policy enables nothing credential-backed.
	 */
	issued: boolean;
	/**
	 * The env-var keys the branch credential's secrets surface under, given what the policy
	 * enables. Empty when the policy enables neither object storage nor the AI Gateway.
	 */
	keys: string[];
	/**
	 * `tokenId`s revoked because this call superseded them. Only ever credentials the persisted
	 * secrets named *and* that this tool issued; empty otherwise.
	 */
	revoked: string[];
	/**
	 * `tokenId`s this call superseded but left live, because `revokeSuperseded` was `false`.
	 * The counterpart to {@link CredentialOutcome.revoked}: exactly the ids that would be
	 * there instead. Lets a caller name what it orphaned rather than saying that it might
	 * have orphaned something — always empty on the default path.
	 */
	superseded: string[];
}

/** A resolved branch env, ready to write to a dotenv file or inject into a process. */
export interface ReusedBranchEnv {
	/** Every Neon env var for the branch, as `{ KEY: value }`. */
	vars: Record<string, string>;
	/** What happened to the branch credential. */
	credential: CredentialOutcome;
	/** Prevents callers from pruning URLs when their absence reflects endpoint failure. */
	functionUrlsUnavailable?: true;
}

/** The branch credential's secrets as persisted in an env source. Empty string means absent. */
interface PersistedSecrets {
	accessKeyId: string;
	secretAccessKey: string;
	apiToken: string;
}

/**
 * Resolve a branch's env while keeping secrets the caller already holds.
 *
 * {@link fetchEnvKeys} reveals the platform default credentials (or mints a fallback when a
 * region has none). Calling it on every `neon dev` start would rewrite `.env` with freshly
 * revealed secrets each time. This wrapper looks at what the caller already has, keeps a
 * half when it already *is* that default (storage and gateway are independent credentials),
 * and asks `fetchEnv` for only the rest.
 *
 * The check is a real verification, not a presence test. A persisted secret is kept only when
 * it names a credential that still exists on this branch, is not revoked or expired, and —
 * when defaults exist — *is* that default. A leftover `neon-env ${branch}` credential this
 * tool minted is replaced by the defaults and revoked. A `.env.example` placeholder, a
 * credential revoked in the console, or one copied in from another branch fails that check.
 *
 * None of this needs local bookkeeping, because the secrets carry their own credential id:
 * `AWS_ACCESS_KEY_ID` **is** the credential's `tokenId` (the storage gateway authenticates
 * against the full id), and the AI Gateway token is minted as `nt_live_<tokenIdShort>_<secret>`,
 * where `tokenIdShort` is what the credentials list reports. The env source being replaced is
 * the record of what the last call issued.
 *
 * ```ts
 * import { fetchEnvReusingSecrets } from "@neon-internals/env-core/reuse-secrets";
 *
 * const { vars, credential } = await fetchEnvReusingSecrets(config, {
 *     projectId,
 *     branch: "main",
 *     env: { ...process.env, ...readEnvFile(".env") },
 * });
 * if (credential.issued) console.log(`new values for ${credential.keys.join(", ")}`);
 * ```
 */
export async function fetchEnvReusingSecrets<const C extends Config>(
	config: C,
	options: FetchEnvOptions & {
		/**
		 * Env source holding secrets a previous call persisted — `process.env` layered with a
		 * `.env` file, typically. Defaults to `process.env`.
		 */
		env?: NodeJS.ProcessEnv;
		/**
		 * Resolve only these OS-level env vars. Omit for every key the policy enables.
		 * Credential verification and minting are scoped to this same selection.
		 */
		keys?: readonly string[];
		/**
		 * Revoke the credential a freshly-minted one supersedes. Defaults to `true`.
		 *
		 * Pass `false` when this resolve covers only *part* of what the branch has. A
		 * partial resolve cannot tell whether a minted leftover its persisted secrets name
		 * also backs a service it is not resolving — and revoking it would kill that service
		 * while its vars, which this call is not rewriting, stay on disk and stop working.
		 * The cost is an orphaned credential, which is the safer of the two failures. An
		 * explicitly scoped `neon env pull` (`--service` or `--env`) is the caller that
		 * needs this. Platform defaults are never revoked.
		 */
		revokeSuperseded?: boolean;
		/** `all-live` lets explicit CLI selection bypass the policy-scoped default. */
		functionUrls?: FunctionUrlMode;
		listedFunctions?: FetchEnvKeysOptions["listedFunctions"];
	},
): Promise<ReusedBranchEnv> {
	const {
		env: source = process.env,
		keys: requestedKeys,
		revokeSuperseded = true,
		...fetchOptions
	} = options;
	const api = options.api ?? createApiFromOptions(options);
	const { branch, desired } = await resolveBranchPolicy(config, options, api);

	const allPolicyKeys = policyEnvKeys(desired);
	const requested = requestedKeys ? new Set(requestedKeys) : null;
	const selectedPolicyKeys =
		requested === null
			? allPolicyKeys
			: [
					...allPolicyKeys.filter((key) => requested.has(key)),
					...[...requested].filter(isFunctionBaseUrlKey).sort(),
				];
	const selected = new Set(selectedPolicyKeys);
	const K = NEON_ENV_VAR_KEYS;
	const storageCredentialSelected =
		(desired.preview?.buckets.length ?? 0) > 0 &&
		(selected.has(K.storage.accessKeyId) ||
			selected.has(K.storage.secretAccessKey));
	const gatewayCredentialSelected =
		(desired.preview?.aiGatewayEnabled ?? false) &&
		selected.has(K.aiGateway.apiKey);
	const secretKeys = credentialEnvKeys({
		storage: storageCredentialSelected,
		aiGateway: gatewayCredentialSelected,
	}).filter((key) => selected.has(key));

	// Nothing credential-backed was selected, so there is nothing to preserve and no
	// credential to spend: fetch the selected values and skip the credentials endpoint.
	if (secretKeys.length === 0) {
		const fetched = await fetchEnvKeysState(
			config,
			fetchOptions,
			requested === null ? null : selectedPolicyKeys,
		);
		return {
			vars: preferPersisted(toEntries(fetched.env), source),
			credential: {
				issued: false,
				keys: [],
				revoked: [],
				superseded: [],
			},
			...(fetched.functionUrlsUnavailable
				? { functionUrlsUnavailable: true as const }
				: {}),
		};
	}

	const persisted = readPersistedSecrets(source);
	const storageCredentialManaged =
		requested === null || storageCredentialSelected;
	const gatewayCredentialManaged =
		requested === null || gatewayCredentialSelected;
	const storageComplete = Boolean(
		persisted.accessKeyId && persisted.secretAccessKey,
	);
	const gatewayComplete = Boolean(persisted.apiToken);

	const listed =
		(storageCredentialManaged && persisted.accessKeyId !== "") ||
		(gatewayCredentialManaged && persisted.apiToken !== "")
			? await api.listCredentials(options.projectId, branch.id)
			: [];
	const named =
		listed.length > 0
			? namedCredentials(listed, persisted)
			: { storage: null, gateway: null };
	const now = Date.now();
	const storageDefault = defaultStorageCredential(listed, now);
	const gatewayDefault = defaultAiGatewayCredential(listed, now);

	const keepStorage =
		!storageCredentialSelected ||
		(storageComplete &&
			halfReusable(named.storage, storageDefault, [
				"storage:read",
				"storage:write",
			]));
	const keepGateway =
		!gatewayCredentialSelected ||
		(gatewayComplete &&
			halfReusable(named.gateway, gatewayDefault, ["ai_gateway:invoke"]));

	const keptSecretKeys = credentialEnvKeys({
		storage: storageCredentialSelected && keepStorage,
		aiGateway: gatewayCredentialSelected && keepGateway,
	}).filter((key) => selected.has(key));

	// Ask for the selected policy values, minus the secrets we're keeping — which is what
	// stops `fetchEnv` from revealing or minting a credential it doesn't need. An unscoped
	// call stays `keys: null`: rewriting it as `policyEnvKeys` would drop
	// `NEON_FUNCTION_*_BASE_URL`.
	const fetchKeys =
		requested === null
			? null
			: selectedPolicyKeys.filter((key) => !keptSecretKeys.includes(key));
	const fetched = await fetchEnvKeysState(
		config,
		// Pass the resolved id so `fetchEnv` targets the same branch this call verified against,
		// even if `options.branch` was a name that has since been reused.
		{
			...fetchOptions,
			branchId: branch.id,
			api,
			...(keptSecretKeys.length > 0 && requested === null
				? { omitKeys: keptSecretKeys }
				: {}),
		},
		fetchKeys,
	);

	const vars = preferPersisted(toEntries(fetched.env), source);
	const unavailable = fetched.functionUrlsUnavailable
		? { functionUrlsUnavailable: true as const }
		: {};
	for (const key of keptSecretKeys) {
		const value = source[key];
		if (value !== undefined) vars[key] = value;
	}

	const issued =
		(storageCredentialSelected && !keepStorage) ||
		(gatewayCredentialSelected && !keepGateway);
	if (!issued) {
		return {
			vars,
			credential: {
				issued: false,
				keys: secretKeys,
				revoked: [],
				superseded: [],
			},
			...unavailable,
		};
	}

	// A replacement was revealed or minted, so revoke leftovers this tool issued: the
	// `neon-env ${branch}` credentials the old secrets named. Platform defaults are never
	// revoked. Everything else on the branch is left alone: it may belong to a teammate,
	// another checkout, or a deployed function.
	//
	// Revoked *after* the fetch, so a failed fetch leaves the caller's existing secrets working.
	const ours = new Set<string>();
	for (const meta of [
		storageCredentialManaged && !keepStorage ? named.storage : null,
		gatewayCredentialManaged && !keepGateway ? named.gateway : null,
	]) {
		if (
			meta !== null &&
			meta.principalType === "user" &&
			meta.name === credentialName(branch.name)
		) {
			ours.add(meta.tokenId);
		}
	}
	if (revokeSuperseded) {
		for (const tokenId of ours) {
			await api.revokeCredential(options.projectId, branch.id, tokenId);
		}
	}

	return {
		vars,
		credential: {
			issued: true,
			keys: secretKeys,
			revoked: revokeSuperseded ? [...ours] : [],
			superseded: revokeSuperseded ? [] : [...ours],
		},
		...unavailable,
	};
}

/** Read the branch credential's secrets out of an env source. */
function readPersistedSecrets(source: NodeJS.ProcessEnv): PersistedSecrets {
	const storage = NEON_ENV_VAR_KEYS.storage;
	const gateway = NEON_ENV_VAR_KEYS.aiGateway;
	return {
		accessKeyId: source[storage.accessKeyId] ?? "",
		secretAccessKey: source[storage.secretAccessKey] ?? "",
		apiToken: source[gateway.apiKey] ?? "",
	};
}

/**
 * Keep a persisted value rather than overwriting it with an empty fetched one.
 *
 * Neon Auth's `base_url` is the case that needs this: integrations created before the API
 * returned it answer with an empty string, and the persisted copy is the only one left. An
 * empty fetched value never carries more information than a non-empty persisted one, so
 * preferring the latter is safe for every var — and it keeps a pull from blanking a working
 * line in someone's `.env`.
 */
function preferPersisted(
	vars: Record<string, string>,
	source: NodeJS.ProcessEnv,
): Record<string, string> {
	const out = { ...vars };
	for (const [key, value] of Object.entries(out)) {
		if (value !== "") continue;
		const persisted = source[key];
		if (persisted !== undefined && persisted !== "") out[key] = persisted;
	}
	return out;
}

/**
 * The credential id embedded in an AI Gateway token. The API mints them as
 * `nt_live_<tokenIdShort>_<secret>`, and `tokenIdShort` is the public identifier the credentials
 * list reports — so a persisted token names the credential that issued it. Returns `null` for
 * anything not in that shape (a `.env.example` placeholder, a hand-typed value), which callers
 * treat as unverifiable.
 */
function gatewayTokenIdShort(apiToken: string): string | null {
	return /^nt_live_([^_]+)_.+$/.exec(apiToken)?.[1] ?? null;
}

/**
 * The live credentials the persisted secrets name — at most one per half. A half that names
 * nothing contributes nothing, which is what a placeholder, a credential revoked in the
 * console, and one copied in from another branch all look like from here.
 */
function namedCredentials(
	live: NeonCredentialMeta[],
	persisted: PersistedSecrets,
): { storage: NeonCredentialMeta | null; gateway: NeonCredentialMeta | null } {
	const usable = live.filter((meta) => isLiveCredential(meta, Date.now()));
	const shortId = persisted.apiToken
		? gatewayTokenIdShort(persisted.apiToken)
		: null;
	return {
		storage: persisted.accessKeyId
			? (usable.find((meta) => meta.tokenId === persisted.accessKeyId) ??
				null)
			: null,
		gateway: shortId
			? (usable.find((meta) => meta.tokenIdShort === shortId) ?? null)
			: null,
	};
}

/**
 * Whether a persisted half can be reused.
 *
 * When a platform default exists, only that default is reusable — a leftover
 * `neon-env ${branch}` mint is replaced. When no default exists (mint fallback),
 * any live credential the secrets name is reusable if it still carries the
 * scopes that half needs.
 */
function halfReusable(
	named: NeonCredentialMeta | null,
	defaultMeta: NeonCredentialMeta | null,
	requiredScopes: CredentialScope[],
): boolean {
	if (named === null) return false;
	if (defaultMeta !== null) return named.tokenId === defaultMeta.tokenId;
	return credentialScopesSatisfied(named.scopes, requiredScopes);
}
